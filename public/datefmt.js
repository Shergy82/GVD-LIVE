/* Shows every date box as DD/MM/YYYY (and date+time as DD/MM/YYYY HH:MM), whatever language the browser or phone is set to.
   The stored value is untouched (still YYYY-MM-DD), so nothing else in the app changes. Clicking the box opens the date picker. */
(function(){
  const fmt=el=>{const v=el.value||'';
    if(el.type==='date'){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(v);return m?`${m[3]}/${m[2]}/${m[1]}`:''}
    const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);return m?`${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`:''};
  function enhance(el){
    if(el.__uk||el.closest('.dwrap'))return;el.__uk=1;
    const w=document.createElement('span');w.className='dwrap'+(el.type==='date'?'':' dt');
    el.parentNode.insertBefore(w,el);w.append(el);
    const t=document.createElement('span');t.className='dtxt';w.append(t);
    const cs=getComputedStyle(el);t.style.left=cs.paddingLeft;t.style.font=cs.font;
    if(cs.display.indexOf('inline')===0||el.style.width==='auto'){w.style.display='inline-block';w.style.width='auto';el.style.width='auto'}   // boxes that sit in a line keep doing so
    const upd=()=>{const s=fmt(el);t.textContent=s||(el.type==='date'?'dd/mm/yyyy':'dd/mm/yyyy hh:mm');t.classList.toggle('ph',!s);t.style.color=s?getComputedStyle(el).color:''};
    upd();['input','change','blur'].forEach(ev=>el.addEventListener(ev,upd));
    el.addEventListener('click',()=>{try{el.showPicker&&el.showPicker()}catch(e){}});
    const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');   // keep in step when the app sets the value in code
    Object.defineProperty(el,'value',{get(){return d.get.call(el)},set(x){d.set.call(el,x);upd()},configurable:true});
  }
  const scan=r=>(r.querySelectorAll?r.querySelectorAll('input[type=date],input[type=datetime-local]'):[]).forEach(enhance);
  new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.nodeType!==1)return;if(n.matches&&n.matches('input[type=date],input[type=datetime-local]'))enhance(n);else scan(n)}))).observe(document.documentElement,{childList:true,subtree:true});
  scan(document);
})();
