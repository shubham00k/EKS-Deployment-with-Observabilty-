import client from 'prom-client'; const register=new client.Registry();
client.collectDefaultMetrics({register,prefix:'taskops_'});
export const httpRequestDuration=new client.Histogram({name:'http_request_duration_seconds',help:'HTTP req duration',labelNames:['method','route','status_code'],buckets:[0.01,0.05,0.1,0.2,0.5,1,2,5]});
register.registerMetric(httpRequestDuration);
export const httpRequestsTotal=new client.Counter({name:'http_requests_total',help:'Total HTTP requests',labelNames:['method','route','status_code']});
register.registerMetric(httpRequestsTotal);
export function metricsEndpoint(){ return async (req,res)=>{ res.set('Content-Type',register.contentType); res.end(await register.metrics()); }; }
export function timingMiddleware(){ return (req,res,next)=>{ const end=httpRequestDuration.startTimer({method:req.method,route:req.path}); res.on('finish',()=>{ httpRequestsTotal.inc({method:req.method,route:req.path,status_code:res.statusCode}); end({status_code:res.statusCode});}); next(); }; }