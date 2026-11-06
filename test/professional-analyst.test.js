import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProfessionalEpisode } from '../src/professional-analyst.js';

const episode={id:'12-1000-a',player:'a',attacker:'b',round:12,tick:1000,reasons:['REPEEK*','WIDE*']};
const frames=[
 {tick:904,t:-1.5,players:[{name:'a',teamNumber:3,x:0,y:0,z:0,yaw:0,hp:100,alive:true},{name:'b',teamNumber:2,x:100,y:0,alive:true}]},
 {tick:968,t:-0.5,players:[{name:'a',teamNumber:3,x:10,y:0,z:0,yaw:0,hp:100,alive:true},{name:'b',teamNumber:2,x:100,y:0,alive:true}]},
 {tick:997,t:-0.05,players:[{name:'a',teamNumber:3,x:20,y:0,z:0,yaw:0,hp:50,alive:true},{name:'b',teamNumber:2,x:100,y:0,alive:true},{name:'mate',teamNumber:3,x:1400,y:0,alive:true}]},
];
test('returns evidence with conservative verdict',()=>{
 const result=analyzeProfessionalEpisode(episode,{frames,sampleHz:4});
 assert.equal(result.mode,'professional');
 assert.equal(result.verdict.status,'insufficient-evidence');
 assert.ok(result.findings.some(f=>f.id==='repeek'));
 assert.ok(result.findings.every(f=>f.confidence==='hypothesis'));
 assert.ok(result.evidence.some(e=>e.id==='duel_distance'&&e.value===80));
 assert.equal(result.comparison.alternative.simulationReady,false);
});
test('does not fabricate facts for missing player data',()=>{
 const result=analyzeProfessionalEpisode({player:'unknown',attacker:'b',tick:1000,round:12,reasons:[]},{frames});
 assert.equal(result.verdict.status,'insufficient-evidence');
 assert.equal(result.evidence.length,0);
});
test('rejects empty replay',()=>{
 assert.throws(()=>analyzeProfessionalEpisode(episode,{frames:[]}));
});
