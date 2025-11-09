import React,{useEffect,useState} from 'react'; import { createRoot } from 'react-dom/client';
function App(){ const [tasks,setTasks]=useState([]); const [title,setTitle]=useState(''); const API=import.meta.env.VITE_API_URL||'http://localhost:4000';
async function load(){ const r=await fetch(`${API}/api/tasks`); setTasks(await r.json()); } useEffect(()=>{load();},[]);
async function addTask(e){ e.preventDefault(); if(!title.trim()) return; await fetch(`${API}/api/tasks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})}); setTitle(''); load(); }
async function setStatus(id,status){ await fetch(`${API}/api/tasks/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})}); load(); }
async function remove(id){ await fetch(`${API}/api/tasks/${id}`,{method:'DELETE'}); load(); }
return (<div style={{maxWidth:640,margin:'40px auto',fontFamily:'system-ui'}}><h1>TaskOps</h1><form onSubmit={addTask} style={{display:'flex',gap:8}}>
<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Add a task..." style={{flex:1,padding:8}} /><button>Add</button></form>
<ul>{tasks.map(t=>(<li key={t.id} style={{display:'flex',alignItems:'center',gap:8,padding:'8px 0'}}>
<span style={{flex:1}}>{t.title} — <em>{t.status}</em></span>
<button onClick={()=>setStatus(t.id,'in_progress')}>In Progress</button>
<button onClick={()=>setStatus(t.id,'done')}>Done</button>
<button onClick={()=>remove(t.id)}>Delete</button>
</li>))}</ul><p style={{marginTop:24}}><a href={`${API}/healthz`} target="_blank">Health</a> • <a href={`${API}/metrics`} target="_blank">Metrics</a></p></div>);}
createRoot(document.getElementById('root')).render(<App/>);