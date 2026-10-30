import { useEffect, useRef, useState } from "react";
import { memory } from "../memory.js";
import ServerMemory from "../components/ServerMemory.jsx";

const KINDS = [["note", "Note"], ["goal", "Goal"], ["body", "Body / injury"], ["routine", "Routine"], ["preference", "Preference"]];
// how the list is grouped: the things that change your plans most come first
const GROUPS = [["body", "Body and injuries"], ["goal", "Goals"], ["routine", "Routine"], ["preference", "Preferences"], ["note", "Notes"]];

export default function Memory() {
  const [list, setList] = useState(memory.all());
  const [text, setText] = useState("");
  const [kind, setKind] = useState("note");
  const [undo, setUndo] = useState(null); // { m, at } the last deleted entry
  const [confirm, setConfirm] = useState(false);
  const timer = useRef(null);
  useEffect(() => memory.subscribe(setList), []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const groups = [...GROUPS, ...[...new Set(list.map((m) => m.kind))].filter((k) => !GROUPS.some(([g]) => g === k)).map((k) => [k, k])]
    .map(([k, l]) => [k, l, list.filter((m) => m.kind === k)]).filter(([, , ms]) => ms.length);

  const remove = (m) => {
    const at = list.indexOf(m);
    memory.remove(m.id); setUndo({ m, at });
    clearTimeout(timer.current); timer.current = setTimeout(() => setUndo(null), 6000);
  };

  return (
    <div className="page memory">
      <header className="report-head">
        <div>
          <span className="tag">Player memory</span>
          <h1 className="h1">What your agent remembers about you</h1>
          <p className="muted">Two places. On your server, what you told your agent, which the Autopilot follows when it plans your week.
            On this device, your goals, injuries, your routine and how you like to play, which your agent plans your games around.</p>
        </div>
      </header>

      <ServerMemory />

      <h2 className="sec-label sm-device-h">On this device</h2>
      <div className="mem-grid">
        <div>
          <section className="panel">
            <h2 className="panel-h"><label htmlFor="mem-text">Add a memory</label></h2>
            <textarea id="mem-text" value={text} onChange={(e) => setText(e.target.value)} rows={4}
              placeholder="e.g. Left shoulder tight this week" />
            <div className="mem-row">
              <div className="seg" role="radiogroup" aria-label="Memory type">
                {KINDS.map(([k, l]) => <button key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>{l}</button>)}
              </div>
              <button className="btn primary" disabled={!text.trim()} onClick={() => { memory.add(text, kind); setText(""); }}>Save</button>
            </div>
          </section>
        </div>

        <section className="panel">
          <div className="mem-head">
            <h2 className="panel-h">On this device · {list.length} entries</h2>
            {confirm
              ? <span className="tiny">Replace everything with the demo entries? <button className="link danger" onClick={() => { memory.reset(); setConfirm(false); }}>Reset</button> · <button className="link" onClick={() => setConfirm(false)}>Keep</button></span>
              : <button className="link" onClick={() => setConfirm(true)}>Reset to demo</button>}
          </div>
          {!list.length && <p className="muted">Nothing stored yet. Add an injury, a goal or how you like to train.</p>}
          {groups.map(([k, label, ms]) => (
            <div key={k} className="mem-group">
              <h3><span className={`mem-kind k-${k}`}>{label}</span><span className="muted">{ms.length}</span></h3>
              <ul className="mem-list">
                {ms.map((m) => (
                  <li key={m.id}>
                    <p>{m.text}</p>
                    <span className="tiny muted">{new Date(m.at).toLocaleDateString("en-GB")} · {m.source}</span>
                    <button className="icon-btn sm" aria-label={`Delete memory: ${m.text}`} onClick={() => remove(m)}>×</button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>
      {undo && (
        <div className="toast" role="status">
          <span>Memory deleted.</span>
          <button className="btn ghost sm" onClick={() => { memory.restore(undo.m, undo.at); setUndo(null); }}>Undo</button>
        </div>
      )}
    </div>
  );
}
