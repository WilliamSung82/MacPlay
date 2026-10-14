const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const engine=path.resolve(__dirname,'../../build/engine');
const plist=require(path.join(engine,'protocol/bplist.js'));

// Exercise the control protocol without creating a real decoder or connecting
// an iPhone. All media operations stay in this isolated module context.
function fixture(){
 const closedVideo=[];
 let counts=[0,0];
 const media={addon:{mediaActivity:()=>counts},onAudioReceiverStarted(){},gstHost:{onAudioStarted(){}},
  closeScreenReceiver(id){closedVideo.push(id)}};
 const module={exports:{}};
 const localRequire=id=>{
  if(id.startsWith('node:'))return require(id);
  if(id==='../media')return media;
  if(id==='./bplist')return plist;
  if(id==='./videoInCar')return require(path.join(engine,'protocol/videoInCar.js'));
  return {};
 };
 vm.runInNewContext(fs.readFileSync(path.join(engine,'protocol/cpStack.js'),'utf8'),
  {module,exports:module.exports,require:localRequire,Buffer,setImmediate,clearInterval,process,
   console:{log(){},warn(){}}});
 const stack=new module.exports.CpStack({mfi:{}});
 const session={audioMeta:[],screenNativeId:7,screenInProcess:true,
  clusterScreenNativeId:null,screen:{stop(){}}};
 stack._liveSession=session;
 return {stack,session,closedVideo,setCounts:(value)=>{counts=value}};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('CarPlay host application button requests the main window',()=>{
 const {stack,session}=fixture();let requested=0;
 stack.on('host-ui-requested',()=>requested++);
 const result=stack._handleCommand({body:plist.encodeBplist({type:'requestUI'})},session);
 assert.equal(result.status,200);assert.equal(requested,1);
});

test('session teardown ends reception even if the control socket remains open',async()=>{
 const {stack,session,closedVideo}=fixture();let ended=0;
 stack.on('session-ended',()=>ended++);
 const result=stack._handleTeardown({body:Buffer.alloc(0)},session);
 assert.equal(result.status,200);assert.deepEqual(closedVideo,[7]);
 assert.equal(ended,0,'allow the RTSP response to be written first');
 await turn();assert.equal(ended,1);assert.equal(stack._liveSession,null);
 stack._handleTeardown({body:Buffer.alloc(0)},session);
 await turn();assert.equal(ended,1,'a repeated teardown does not repeat disconnect');
});

test('audio-only teardown preserves the CarPlay window and session',async()=>{
 const {stack,session,closedVideo}=fixture();let ended=0;
 stack.on('session-ended',()=>ended++);
 stack._handleTeardown({body:plist.encodeBplist({streams:[{type:100}]})},session);
 await turn();assert.deepEqual(closedVideo,[]);assert.equal(ended,0);
 assert.equal(stack._liveSession,session);
});

test('stopping the host suppresses an already queued passive disconnect',async()=>{
 const {stack,session}=fixture();let ended=0;
 stack.on('session-ended',()=>ended++);
 stack._handleTeardown({body:Buffer.alloc(0)},session);stack.stop();
 await turn();assert.equal(ended,0);
});

test('no negotiated heartbeat keeps static video connected',()=>{
 const {stack,session}=fixture();session.lastCtrlReadNs=1n;let ends=0;stack.on('session-ended',()=>ends++);
 stack._checkHeartbeat(session);assert.equal(ends,0);
});
test('established heartbeat timeout ends only the live session once',()=>{
 const {stack,session}=fixture();session.lastCtrlReadNs=1n;session.timing={lastActivityNs:1n,stop(){}};session.mediaCounts=[0,0];let ends=0;
 stack.on('session-ended',()=>ends++);stack._checkHeartbeat(session);stack._checkHeartbeat(session);assert.equal(ends,1);
});
test('active decrypted media prevents a heartbeat false positive',()=>{
 const {stack,session,setCounts}=fixture();session.lastCtrlReadNs=1n;session.timing={lastActivityNs:1n,stop(){}};session.mediaCounts=[0,0];setCounts([1,0]);
 stack.on('session-ended',()=>assert.fail());stack._checkHeartbeat(session);
});
