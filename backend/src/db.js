import pkg from 'pg'; const { Pool } = pkg;
const pool=new Pool({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER||'taskops',password:process.env.DB_PASSWORD||'taskops123',database:process.env.DB_NAME||'taskops'});
export async function initDb(){ await pool.query(`CREATE TABLE IF NOT EXISTS tasks(id SERIAL PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMP DEFAULT NOW());`); }
export const db={ async all(){ return (await pool.query('SELECT * FROM tasks ORDER BY id DESC')).rows; },
  async create(title){ return (await pool.query('INSERT INTO tasks(title) VALUES($1) RETURNING *',[title])).rows[0]; },
  async update(id,fields){ const keys=Object.keys(fields); if(!keys.length) return null; const sets=keys.map((k,i)=>`${k}=$${i+1}`).join(', '); const vals=keys.map(k=>fields[k]); vals.push(id);
    const r=await pool.query(`UPDATE tasks SET ${sets} WHERE id=$${keys.length+1} RETURNING *`,vals); return r.rows[0]; },
  async remove(id){ await pool.query('DELETE FROM tasks WHERE id=$1',[id]); return true; } };