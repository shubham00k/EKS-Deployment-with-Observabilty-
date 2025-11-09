# TaskOps EKS Debugging Playbook — Errors, Fixes & Commands

A clean, step‑by‑step record of every issue we hit, how we diagnosed it, the exact commands we ran, and how we verified each fix.

---

## 0) Setup Context

* **Stack:** React (frontend) + Node/Express (backend) + Postgres + Jaeger
* **Targets:** Local Docker Compose and AWS EKS
* **Namespace:** `taskops`

---

## 1) Backend container missing (Docker Compose)

**Symptom**
`docker ps` showed frontend, postgres, jaeger, but **no backend container**.

**Root Cause**
Backend started before Postgres was ready → DB connect failed → backend exited.

**Key Logs**

```
Error: connect ECONNREFUSED 172.21.0.2:5432
```

**Fix (Compose healthcheck + depends_on)**

```yaml
# docker-compose.yml (relevant parts)
postgres:
  image: postgres:16-alpine
  ...
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U taskops -h localhost"]
    interval: 5s
    timeout: 3s
    retries: 5

backend:
  build: ./backend
  env_file:
    - ./backend/.env.example
  ports:
    - "4000:4000"
  environment:
    DB_HOST: postgres
    JAEGER_AGENT_HOST: jaeger
  depends_on:
    postgres:
      condition: service_healthy
```

**Rebuild & Run**

```bash
docker compose down -v
docker compose build --no-cache
docker compose up
```

**Verification**

* Backend logs show: `taskops backend listening on 4000`
* `curl http://localhost:4000/healthz` → `{ "ok": true }`

**Prevention**
Always gate app startup on DB readiness (compose healthcheck or app‑level retry logic).

---

## 2) `kubectl apply` fails on `:Zone.Identifier`

**Symptom**
Deploy script errored on a weird file name: `01-db-secret.yaml:Zone.Identifier`.

**Root Cause**
Windows attached an alternate data stream when downloading/unzipping; not a valid YAML.

**Fix**
Delete those metadata files and ignore any filename containing a colon.

```bash
find ./k8s -type f -name "*:Zone.Identifier" -delete
```

(Optional) Update deploy script to skip files with `:`.

**Verification**
Re-run deploy script → no YAML parse errors.

**Prevention**
Run the `find ... -delete` after unzip or avoid unzipping via Windows explorer.

---

## 3) Postgres pod `Pending` on EKS (PVC not bound)

**Symptom**
`postgres-0` stuck in `Pending`. Describe shows:

```
pod has unbound immediate PersistentVolumeClaims
```

**Root Cause**
No functioning dynamic provisioner / default `StorageClass` compatible with EBS CSI.

**Diagnostics**

```bash
kubectl get storageclass
kubectl get pvc -n taskops
kubectl get pods -n kube-system | grep ebs
```

* Observed only `gp2` (old in-tree) class.
* EBS CSI controller pods were **crashing** initially.

**Fix A — Repair EBS CSI driver & IRSA**
(Controller logs showed missing credentials: *no EC2 IMDS role found*.)

```bash
# Associate cluster OIDC for IRSA
eksctl utils associate-iam-oidc-provider \
  --cluster taskops-cluster --region ap-south-1 --approve

# Remove broken addon & SA
eksctl delete addon --name aws-ebs-csi-driver \
  --cluster taskops-cluster --region ap-south-1
kubectl delete sa ebs-csi-controller-sa -n kube-system --ignore-not-found

# Create IAM role + SA for controller
eksctl create iamserviceaccount \
  --name ebs-csi-controller-sa \
  --namespace kube-system \
  --cluster taskops-cluster \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --approve \
  --role-name AmazonEKS_EBS_CSI_DriverRole

# Install addon bound to that role
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
eksctl create addon --name aws-ebs-csi-driver \
  --cluster taskops-cluster \
  --service-account-role-arn arn:aws:iam::$ACCOUNT_ID:role/AmazonEKS_EBS_CSI_DriverRole \
  --region ap-south-1 --force
```

**Fix B — Create CSI `gp3` StorageClass & make default**

```bash
cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
EOF
```

**Redeploy Postgres**

```bash
kubectl delete statefulset postgres -n taskops --ignore-not-found
kubectl delete pvc -n taskops --all
kubectl apply -f k8s/10-postgres.yaml
```

**Verification**

```bash
kubectl get pvc -n taskops   # STATUS: Bound (gp3)
kubectl get pods -n taskops  # postgres-0 Running
```

**Prevention**
On fresh EKS, always install EBS CSI addon with IRSA and use a CSI class (gp3) as default.

---

## 4) Postgres container `Error`: `lost+found` blocks initdb

**Symptom**
Postgres logs:

```
initdb: error: directory "/var/lib/postgresql/data" exists but is not empty
... contains a lost+found directory
```

**Root Cause**
EBS volumes create `lost+found` at filesystem root. Postgres refuses non-empty data dir.

**Fix (use subdirectory via PGDATA)**
In StatefulSet, mount the volume as usual but point `PGDATA` to a subfolder:

```yaml
env:
  - name: PGDATA
    value: /var/lib/postgresql/data/pgdata
volumeMounts:
  - name: data
    mountPath: /var/lib/postgresql/data
```

**Redeploy**

```bash
kubectl delete statefulset postgres -n taskops --ignore-not-found
kubectl delete pvc -n taskops --all
kubectl apply -f k8s/10-postgres.yaml
```

**Verification**
`postgres-0` reaches **Running** and remains stable.

**Prevention**
Always set `PGDATA` to a subfolder for Postgres on fresh block volumes.

---

## 5) Backend `CrashLoopBackOff` after DB fix

**Symptom**
Backend pods stayed in `CrashLoopBackOff` even after DB became healthy (first cycle).

**Root Cause**
Pods had already failed on the earlier DB outage; needed a clean restart to re-init the pool.

**Fix (restart pods)**

```bash
kubectl delete pods -n taskops -l app=backend
```

**Verification**
New backend pods come up `1/1 Running`.
`kubectl logs deployment/backend -n taskops --tail=50` shows successful start.

**Prevention**
Add retry/backoff logic in app init; use readiness probes to avoid early traffic.

---

## 6) Frontend reachable but tasks not saving

**Symptom**
Frontend (LB) opens in browser but task creation doesn’t persist.

**Root Cause**
Backend service was `ClusterIP` (internal only). The React app in the **browser** was calling a non-public API.

**Fix Option A — Make backend public for testing**

```bash
kubectl patch svc backend -n taskops -p '{"spec": {"type": "LoadBalancer"}}'
```

Update frontend `VITE_API_URL` to backend’s external DNS/port if needed.

**Fix Option B — Production pattern (recommended)**

* Keep backend `ClusterIP` (internal).
* Serve frontend from inside the cluster with `VITE_API_URL=http://backend.taskops.svc.cluster.local:4000` baked at build-time.

**Verification**
Network tab shows 2xx from `/api/tasks`; UI updates after add.

**Prevention**
For public UIs, front the API via Ingress or API Gateway; avoid exposing DB or internal services directly.

---

## 7) `kubectl get svc - taskops` error

**Symptom**

```
Error from server (NotFound): services "-" not found
```

**Root Cause**
CLI syntax typo: `-` was parsed as the literal service name. Correct flag is `-n` for namespace.

**Fix**

```bash
kubectl get svc -n taskops
```

**Verification**
Services list displays normally with `CLUSTER-IP` and `EXTERNAL-IP`.

---

## 8) EKS context & access (reference)

**Goal**
Connect `kubectl` to the cluster and set a friendly context name.

**Commands**

```bash
aws eks update-kubeconfig --region ap-south-1 --name taskops-cluster --alias taskops
kubectl config use-context taskops
kubectl get nodes
```

---

## 9) Deploy helper scripts (reference)

**Deploy all k8s manifests in order**

```bash
./deploy_k8s.sh
```

* Applies namespace → secrets/config → everything else
* Prints `kubectl get all -n taskops` summary

**Cleanup (delete everything applied)**

```bash
kubectl delete -f ./k8s --ignore-not-found=true
```

Or:

```bash
kubectl delete namespace taskops
```

---

## 10) Final State Checklist

* [x] `ebs-csi-controller` 6/6 Running; `ebs-csi-node` 3/3 Running
* [x] `gp3` StorageClass exists and/or default
* [x] Postgres `PGDATA` subdir set; `postgres-0` Running
* [x] Backend pods Running and healthy
* [x] Services: frontend `LoadBalancer`, backend `LoadBalancer` (test) or `ClusterIP` (prod)
* [x] Frontend UI creates tasks successfully

---

## 11) Hardening Next Steps

* Add **readiness & liveness probes** for backend and Postgres
* Add **initContainer** in backend to wait for DB TCP before start
* Wire **Prometheus Operator + ServiceMonitor** for `/metrics`
* Deploy **EFK** and **Jaeger** in cluster-wide namespaces
* Secure external access via **Ingress + TLS (ACM)** and DNS (Route53)

---

### Appendix — One‑liners

* Create `gp3` CSI StorageClass as default:

```bash
kubectl apply -f - <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
EOF
```

* Restart backend pods:

```bash
kubectl delete pods -n taskops -l app=backend
```

* Expose backend quickly (testing):

```bash
kubectl patch svc backend -n taskops -p '{"spec":{"type":"LoadBalancer"}}'
```

---

**End of Playbook**
This document captures the exact errors, root causes, commands, and verifications from end to end so you can reuse the flow on future clusters confidently.
