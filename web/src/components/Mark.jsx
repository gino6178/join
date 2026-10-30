// The shuttle mark: a flight arc and the shuttle. The agent's face across the app.
export default function Mark({ size = 26 }) {
  return <svg className="mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true"><path d="M10 48 C 22 8, 42 8, 54 30" /><circle cx="54" cy="30" r="5" /></svg>;
}
