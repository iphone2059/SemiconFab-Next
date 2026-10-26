(async()=>{
 const canvas=renderer.domElement;
 document.querySelectorAll('body *').forEach(e=>e.style.setProperty('visibility','hidden','important'));Object.assign(canvas.style,{position:'fixed',left:'0',top:'0',width:'512px',height:'512px',zIndex:'99999'});canvas.style.setProperty('visibility','visible','important');
 const lights=[];scene.traverse(o=>{if(o.isLight)lights.push(o)});
 scene.children.forEach(o=>{if(!o.isLight)o.visible=false});
 lights.forEach(l=>l.visible=['AmbientLight','DirectionalLight'].includes(l.type));
 scene.fog=null;renderer.shadowMap.enabled=false;
 camera.position.set(0,6,6);camera.aspect=1;camera.updateProjectionMatrix();controls.target.set(0,0,0);camera.lookAt(0,0,0);
 renderer.setPixelRatio(1);renderer.setSize(512,512);
 const specs=[[0xeeeef5,.22,.38],[0x8c94a3,.22,.38],[0x1e293b,.15,.75],[0xd8e2ec,.92,.18],[0xc77a4d,.5,.35]];
 for(let i=0;i<specs.length;i++){
  const [col,metal,rough]=specs[i];const m=new THREE.Mesh(new THREE.BoxGeometry(1,.1,1),new THREE.MeshStandardMaterial({color:col,metalness:metal,roughness:rough}));m.position.set((i-2)*1.2,0,0);scene.add(m);
 }
 canvas.style.setProperty('width','512px','important');canvas.style.setProperty('height','512px','important');renderer.setSize(512,512,false);renderer.render(scene,camera);await new Promise(r=>setTimeout(r,250));
 return {specs,lights:lights.filter(l=>l.visible&&l.parent===scene).map(l=>({type:l.type,color:l.color.toArray(),intensity:l.intensity})),camera:camera.position.toArray()};
})()
