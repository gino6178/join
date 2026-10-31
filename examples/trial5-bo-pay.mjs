const B="join_g_eyJjIjoiYy05NTA0YWViZiIsIm4iOiJjV0FvUG9rdFFsTmYifQDyN_-p0gQTsFLqOE2GeLzk";
const call=async(t,b={})=>(await fetch("http://192.168.31.145:8799/api/agent/"+t,{method:"POST",headers:{Authorization:"Bearer "+B,"Content-Type":"application/json","X-Join-Name":"Bo"},body:JSON.stringify(b)})).json();
const w=await call("whoami");
console.log(JSON.stringify(await call("pay_my_share",{booking:"bk_a9c982f5ff1c",mandate:w.ap2.openPaymentMandate,amount:10})));
