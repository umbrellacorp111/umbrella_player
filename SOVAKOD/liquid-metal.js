(function(){
'use strict';
var VERT='attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}';
var FRAG=[
'precision highp float;',
'uniform vec2 u_res;uniform float u_time;uniform float u_speed;',
'uniform vec3 u_col1;uniform vec3 u_col2;uniform vec3 u_col3;',
'',
'vec3 permute(vec3 x){return mod(((x*34.0)+1.0)*x,289.0);}',
'float snoise(vec2 v){',
'  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);',
'  vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);',
'  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);',
'  vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;',
'  i=mod(i,289.0);',
'  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));',
'  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);',
'  m=m*m;m=m*m;',
'  vec3 x=2.0*fract(p*C.www)-1.0;vec3 h=abs(x)-0.5;',
'  vec3 ox=floor(x+0.5);vec3 a0=x-ox;',
'  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);',
'  vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;',
'  return 130.0*dot(m,g);',
'}',
'',
'void main(){',
'  vec2 uv=gl_FragCoord.xy/u_res;',
'  float t=u_time*0.08*u_speed;',
'',
'  float n1=snoise(vec2(uv.x*3.0+t*0.4,uv.y*0.5+t*0.2));',
'  float n2=snoise(vec2(uv.x*5.0-t*0.3,uv.y*0.8-t*0.15));',
'  float n3=snoise(vec2(uv.x*1.5+t*0.15,uv.y*2.0+t*0.3));',
'',
'  float stripe=uv.x*8.0+n1*1.2+n2*0.4;',
'  float metal=fract(stripe);',
'  metal=smoothstep(0.1,0.35,metal)*smoothstep(0.9,0.55,metal);',
'  metal=pow(metal,0.8);',
'',
'  float highlight=smoothstep(0.6,0.8,n2)*smoothstep(0.3,0.6,uv.y);',
'  float shadow=smoothstep(0.4,0.1,n3)*smoothstep(0.7,0.3,uv.y);',
'',
'  vec3 col=mix(u_col1,u_col2,metal);',
'  col=mix(col,u_col3,highlight*0.5);',
'  col=mix(col,u_col1*0.3,shadow*0.4);',
'',
'  float edgeBright=pow(1.0-abs(uv.y*2.0-1.0),3.0);',
'  col+=u_col3*edgeBright*0.15;',
'',
'  float shimmer=snoise(vec2(uv.x*12.0+t*2.0,uv.y*3.0))*0.5+0.5;',
'  shimmer=pow(shimmer,6.0);',
'  col+=vec3(1.0)*shimmer*0.08;',
'',
'  gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);',
'}'
].join('\n');

function hexToRgb(hex){var h=hex.replace('#','');return[parseInt(h.slice(0,2),16)/255,parseInt(h.slice(2,4),16)/255,parseInt(h.slice(4,6),16)/255];}

window.initLiquidMetal=function(container,opts){
opts=opts||{};
var col1=opts.color1||'#1a1a2e';
var col2=opts.color2||'#3a3a5c';
var col3=opts.color3||'#7a7a9e';
var speed=opts.speed!=null?opts.speed:1.0;
var canvas=document.createElement('canvas');
canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
canvas.setAttribute('aria-hidden','true');
container.style.position=container.style.position||'relative';
container.style.overflow='hidden';
container.insertBefore(canvas,container.firstChild);
var gl=canvas.getContext('webgl',{antialias:true,alpha:false});
if(!gl)return null;
function compile(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){gl.deleteShader(s);return null;}return s;}
var vs=compile(gl.VERTEX_SHADER,VERT);
var fs=compile(gl.FRAGMENT_SHADER,FRAG);
if(!vs||!fs)return null;
var pg=gl.createProgram();gl.attachShader(pg,vs);gl.attachShader(pg,fs);gl.linkProgram(pg);
if(!gl.getProgramParameter(pg,gl.LINK_STATUS)){gl.deleteProgram(pg);return null;}
gl.useProgram(pg);
var buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
var pos=gl.getAttribLocation(pg,'position');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
var loc={};['u_res','u_time','u_speed','u_col1','u_col2','u_col3'].forEach(function(n){loc[n]=gl.getUniformLocation(pg,n);});
var c1=hexToRgb(col1),c2=hexToRgb(col2),c3=hexToRgb(col3);
gl.uniform3f(loc.u_col1,c1[0],c1[1],c1[2]);
gl.uniform3f(loc.u_col2,c2[0],c2[1],c2[2]);
gl.uniform3f(loc.u_col3,c3[0],c3[1],c3[2]);
function resize(){var d=Math.min(window.devicePixelRatio||1,2);var w=container.getBoundingClientRect();canvas.width=Math.max(1,Math.floor(w.width*d));canvas.height=Math.max(1,Math.floor(w.height*d));gl.viewport(0,0,canvas.width,canvas.height);gl.uniform2f(loc.u_res,canvas.width,canvas.height);}
resize();
var ro=new ResizeObserver(resize);ro.observe(container);
var start=performance.now();var raf=0;var paused=false;
var reduceMq=(window.matchMedia?window.matchMedia('(prefers-reduced-motion: reduce)'):null);
function motionOK(){return !document.hidden&&!(reduceMq&&reduceMq.matches);}
function kick(){if(paused||raf||!motionOK())return;raf=requestAnimationFrame(render);}
function render(now){raf=0;if(paused)return;
gl.uniform1f(loc.u_time,(now-start)/1000);
gl.uniform1f(loc.u_speed,speed);
gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
if(motionOK())raf=requestAnimationFrame(render);}
render(performance.now());kick();
function onVis(){if(document.hidden){if(raf){cancelAnimationFrame(raf);raf=0;}}else{kick();}}
document.addEventListener('visibilitychange',onVis);
if(reduceMq&&reduceMq.addEventListener){reduceMq.addEventListener('change',function(){if(motionOK())kick();});}
return{destroy:function(){cancelAnimationFrame(raf);raf=0;document.removeEventListener('visibilitychange',onVis);ro.disconnect();gl.deleteBuffer(buf);gl.deleteProgram(pg);gl.deleteShader(vs);gl.deleteShader(fs);},
pause:function(){paused=true;if(raf){cancelAnimationFrame(raf);raf=0;}},
resume:function(){if(!paused)return;paused=false;start=performance.now();kick();}};
};
})();