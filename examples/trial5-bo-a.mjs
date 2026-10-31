const B="join_g_eyJjIjoiYy05NTA0YWViZiIsIm4iOiJjV0FvUG9rdFFsTmYifQDyN_-p0gQTsFLqOE2GeLzk";
const call=async(t,b={})=>{const r=await fetch("http://192.168.31.145:8799/api/agent/"+t,{method:"POST",headers:{Authorization:"Bearer "+B,"Content-Type":"application/json","X-Join-Name":"Bo"},body:JSON.stringify(b)});return r.text()};
const [t,b]=[process.argv[2],JSON.parse(process.argv[3]||"{}")];
console.log(await call(t,b));
