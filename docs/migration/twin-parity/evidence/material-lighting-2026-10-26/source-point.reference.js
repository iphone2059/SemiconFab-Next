(()=>{
 renderer.setSize(512,512,false);camera.aspect=1;camera.updateProjectionMatrix();
 const lights=[];scene.traverse(o=>{if(o.isLight)lights.push(o)});lights.forEach(l=>l.visible=false);
 const swatch=scene.children.filter(o=>o.isMesh&&o.visible)[2];
 swatch.material.color.setHex(0xffffff);swatch.material.metalness=0;swatch.material.roughness=1;
 for(let i=0;i<8;i++){const l=new THREE.PointLight(0xffffff,1,1,2);l.position.set(1000+i,1000,1000);scene.add(l)}
 const values=[];const gl=renderer.getContext();
 for(const decay of [1,1.2,1.5,2]){
  const light=new THREE.PointLight(0xffffff,1,10,decay);light.position.set(0,5.05,0);scene.add(light);
  renderer.render(scene,camera);const pixel=new Uint8Array(4);gl.readPixels(256,258,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
  values.push({decay,pixel:[...pixel]});scene.remove(light);
 }
 return {values,error:gl.getError()};
})()
