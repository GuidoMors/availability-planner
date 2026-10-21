import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type User = { id: string; username: string };
type Slot = { day: number; slot: number; available: boolean };
type Group = { id: string; name: string; color: string; owner: User; members: User[] };
type Layer = { id: string; name: string; color: string; grid: boolean[][]; baseline?:boolean[][]; locked?:boolean[][] };
type LayerPayload = { id: string; name: string; color: string; slots: Slot[]; locked?:Slot[] };
type GroupSlot = { day: number; slot: number; status: "green" | "red" | "yellow"; unavailable: string[]; groupOnly: boolean };
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const emptyGrid = (): boolean[][] => Array.from({ length: 7 }, () => Array(96).fill(false));
const mondayOf = (d: Date) => { const x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const labelTime = (slot: number) => `${String(Math.floor(slot / 4)).padStart(2,"0")}:${String((slot % 4) * 15).padStart(2,"0")}`;
const toGrid = (slots: Slot[]) => { const g = emptyGrid(); slots.forEach(s => { if(g[s.day]) g[s.day][s.slot] = s.available; }); return g; };
const toLayers = (payload: LayerPayload[]): Layer[] => payload.map(l => ({ id: l.id, name: l.name, color: l.color, grid: toGrid(l.slots), ...(l.locked?{locked:toGrid(l.locked)}:{}) }));
// Show every active availability layer in its own band.
function slotLook(grid: boolean[][], layers: Layer[], d: number, s: number, previewGrid?:boolean[][], splitGroup=true): { cls: string; style?: React.CSSProperties; label: string } {
  const on = layers.filter(l => l.grid[d][s]||l.locked?.[d][s]);
  const audiences = [...(grid[d][s] ? ["everyone"] : []), ...on.map(l => `${l.name} only`)];
  if (on.length) {
    const availabilityColor = grid[d][s] ? "#38bd8a" : "var(--personal-unavailable)";
    return { cls: "is-group", style: { background: splitGroup?`linear-gradient(to bottom, ${availabilityColor} 0 50%, ${on[0].color} 50% 100%)`:on[0].color }, label: splitGroup?`Personal availability ${grid[d][s]?"available":"unavailable"}; scheduled session for ${on[0].name}`:`Scheduled for ${on[0].name}` };
  }
  if (previewGrid?.[d][s]) return { cls: "is-preview", label: "Available to this group" };
  if (!grid[d][s]) return { cls: "is-unavailable", label: "Unavailable" };
  return { cls: "is-available", style: { background: "#38bd8a" }, label: `Available to ${audiences.join(" and ")}` };
}
const toSlots = (grid: boolean[][]): Slot[] => grid.flatMap((day,d) => day.map((available,slot) => ({day:d,slot,available})));
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `Request failed (${response.status})`); }
  if (response.status === 204) return undefined as T;
  return response.json();
}
function ScheduleGrid({ grid, baselineGrid, layers=[], activeGroup, editable=false, scope, onChange, onChangeGroup, previewGrid }: { grid:boolean[][]; baselineGrid:boolean[][]; layers?:Layer[]; activeGroup?:Layer; editable?:boolean; scope:"weekly"|"biweekly"|"week"; onChange?:(g:boolean[][])=>void; onChangeGroup?:(g:boolean[][])=>void; previewGrid?:boolean[][] }) {
  const [hoveredSlot, setHoveredSlot] = useState<{ day:number; slot:number }|null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x:number; y:number }|null>(null);
  const [dragSelection, setDragSelection] = useState<{ day:number; from:number; to:number; value:boolean }|null>(null);
  const drag = useRef<{ day: number; start:number; end:number; value: boolean } | null>(null);
  const slots = Array.from({length:96}, (_,i)=>i);
  const visible = layers.map(layer=>activeGroup?.id===layer.id?{...layer,...activeGroup}:layer);
  useEffect(() => {
    const finish = () => { drag.current = null; setDragSelection(null); };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => { window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); };
  }, []);
  const current = (d:number, s:number) => activeGroup ? activeGroup.grid[d][s] : grid[d][s];
  const isLocked = (d:number,s:number) => visible.some(layer=>(layer.grid[d][s]||layer.locked?.[d][s])&&(layer.id!==activeGroup?.id||!layer.grid[d][s]));
  const paint = (d:number, s:number, value:boolean) => {
    if (!editable || (activeGroup&&isLocked(d,s)) || current(d, s) === value) return;
    if (activeGroup) {
      if (!onChangeGroup) return;
      const next=activeGroup.grid.map(row=>[...row]); next[d][s]=value; onChangeGroup(next);
    } else {
      if (!onChange) return;
      const next=grid.map(row=>[...row]); next[d][s]=value; onChange(next);
    }
  };
  const beginPaint = (d:number, s:number) => {
    if (!editable) return;
    const baseline=activeGroup?.baseline?.[d][s]??baselineGrid[d][s];
    const value=scope!=="weekly"&&current(d,s)!==baseline?baseline:!current(d,s);
    drag.current = { day:d, start:s, end:s, value };
    setDragSelection({day:d,from:s,to:s,value:drag.current.value});
    paint(d, s, drag.current.value);
  };
  const continuePaint = (d:number, s:number) => {
    if (drag.current && drag.current.day === d) {
      drag.current.end=s;
      setDragSelection({day:d,from:Math.min(drag.current.start,s),to:Math.max(drag.current.start,s),value:drag.current.value});
      paint(d, s, drag.current.value);
    }
  };
  const trackHover = (d:number, s:number, e:React.PointerEvent<HTMLButtonElement>) => {
    setHoveredSlot({day:d,slot:s});
    setHoverPosition({
      x:Math.max(8,Math.min(e.clientX+12,window.innerWidth-260)),
      y:Math.max(8,Math.min(e.clientY+12,window.innerHeight-72))
    });
  };
  const setRange = (value:boolean) => {
    const source=activeGroup?.grid||grid;
    const next=source.map((row,d)=>row.map((available,s)=>activeGroup&&isLocked(d,s)?available:value));
    if (activeGroup) { onChangeGroup?.(next); return; }
    onChange?.(next);
  };
  return <div className="schedule-editor">
    <div className="grid-toolbar"><div className="grid-legend">{previewGrid&&<span><i className="dot group-preview-dot"/>Group available</span>}<span><i className="dot available-dot"/>Everyone</span>{visible.map(l=><span key={l.id}><i className="dot" style={{background:l.color}}/>{l.name}</span>)}<span><i className="dot unavailable-dot"/>Unavailable</span></div>{editable&&<div className="range-tools"><button className="mini-button" onClick={()=>setRange(true)}>All week available</button><button className="mini-button" onClick={()=>setRange(false)}>All week unavailable</button></div>}</div>
    {editable&&<div className="grid-feedback" aria-live="polite">{dragSelection?`Setting ${DAYS[dragSelection.day]} ${dragSelection.value?"available":"unavailable"} · ${labelTime(dragSelection.from)}–${labelTime(dragSelection.to+1)}`:scope!=="weekly"?"Highlighted blocks are overrides. Click one to restore the every-week schedule; drag to edit hours.":"Hover over a block to see its time; drag to set availability."}</div>}
    <div className="editor-time-axis"><div/><div className="time-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div></div>
    <div className="editor-days">{DAYS.map((day,d)=><div className="editor-day-row" key={day}>
      <strong className="editor-day-label">{day}</strong>
      <div className="slot-grid">{slots.map(s=>{const look=slotLook(grid,visible,d,s,previewGrid,!activeGroup);const locked=!!activeGroup&&isLocked(d,s);const assignedTo=visible.find(layer=>(layer.grid[d][s]||layer.locked?.[d][s])&&(layer.id!==activeGroup?.id||!layer.grid[d][s]));const baseline=activeGroup?.baseline?.[d][s]??baselineGrid[d][s];const exception=scope!=="weekly"&&current(d,s)!==baseline;return <button key={s} aria-label={`${day} ${labelTime(s)} ${exception?"Schedule override; click to restore weekly hours. ":""}${locked?`Reserved for ${assignedTo?.name}. `:""}${look.label}`} title={exception?"Schedule override · click to restore weekly hours":locked?`Reserved for ${assignedTo?.name}`:undefined} disabled={!editable||locked} style={look.style} className={`slot ${look.cls} ${locked?"is-locked":""} ${exception?"is-exception":""} ${s%4===0?"hour-start":""}`} onPointerDown={e=>{e.preventDefault();beginPaint(d,s);}} onPointerEnter={e=>{trackHover(d,s,e);continuePaint(d,s);}} onPointerMove={e=>trackHover(d,s,e)} onPointerLeave={()=>{if(!drag.current){setHoveredSlot(null);setHoverPosition(null);}}} onClick={()=>{}}/>;})}</div>
    </div>)}</div>
    {editable&&hoveredSlot!==null&&hoverPosition&&<div className="time-hover-message" style={{left:hoverPosition.x,top:hoverPosition.y}} aria-hidden="true">{DAYS[hoveredSlot.day]} {labelTime(hoveredSlot.slot)}–{labelTime(hoveredSlot.slot+1)} · {slotLook(grid,visible,hoveredSlot.day,hoveredSlot.slot).label}</div>}
    <div className="editor-foot"><span>96 slots per day · 15-minute increments</span></div>
  </div>;
}
function WeeklyOverview({grid,layers=[]}:{grid:boolean[][];layers?:Layer[]}) {
  return <div className="weekly-overview">
    <div className="weekly-overview-axis"><span>Day</span><div className="time-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div></div>
    {DAYS.map((day,d)=><div className="weekly-overview-row" key={day}>
      <div className="weekly-overview-day"><strong>{day}</strong><span>{grid[d].filter((a,s)=>a||layers.some(l=>l.grid[d][s])).length * 15 / 60}h available</span></div>
      <div className="weekly-overview-slots" aria-label={`${day} availability`}>
        {grid[d].map((_,s)=>{const look=slotLook(grid,layers,d,s);return <span key={s} style={look.style} className={`weekly-overview-slot ${look.cls} ${s%4===0?"hour-start":""}`} title={`${day} ${labelTime(s)} · ${look.label}`}/>;})}
      </div>
    </div>)}
    <div className="weekly-overview-legend"><span><i className="dot available-dot"/> Available to everyone</span>{layers.map(l=><span key={l.id}><i className="dot" style={{background:l.color}}/> {l.name}</span>)}<span><i className="dot unavailable-dot"/> Unavailable</span></div>
  </div>;
}

export default function App() {
  const [user,setUser]=useState<User|null>(null);
  const [mode,setMode]=useState<"login"|"register"|"forgot"|"reset">("login");
  const [form,setForm]=useState({username:"",email:"",password:"",token:""});
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const [page,setPage]=useState<"my-schedule"|"edit-schedule"|"people"|"groups">("my-schedule");
  const [theme,setTheme]=useState<"light"|"dark">(()=>localStorage.getItem("availability-theme")==="dark"?"dark":"light");
  const [overviewGrid,setOverviewGrid]=useState<boolean[][]>(emptyGrid());
  const [overviewLayers,setOverviewLayers]=useState<Layer[]>([]);
  const [scheduleLayers,setScheduleLayers]=useState<Layer[]>([]);
  const [saveScope,setSaveScope]=useState<"weekly"|"biweekly"|"week">("weekly");
  const [biweeklyAnchorWeekStart,setBiweeklyAnchorWeekStart]=useState<string|null>(null);
  const [baseGrid,setBaseGrid]=useState<boolean[][]>(emptyGrid());
  const [week,setWeek]=useState(()=>mondayOf(new Date()));
  const [grid,setGrid]=useState<boolean[][]>(emptyGrid());
  const [dirty,setDirty]=useState(false);
  const [groups,setGroups]=useState<Group[]>([]);
  const [groupName,setGroupName]=useState("");
  const [groupColor,setGroupColor]=useState("#5667df");
  const [memberNames,setMemberNames]=useState<Record<string,string>>({});
  const [selectedGroup,setSelectedGroup]=useState("");
  const [selectedGroupView,setSelectedGroupView]=useState<"calendar"|"schedule">("calendar");
  const [groupSlots,setGroupSlots]=useState<GroupSlot[]>([]);
  const [groupMembers,setGroupMembers]=useState<string[]>([]);
  const [groupSaveScope,setGroupSaveScope]=useState<"weekly"|"biweekly"|"week">("weekly");
  const [groupAssignmentGrid,setGroupAssignmentGrid]=useState<boolean[][]>(emptyGrid());
  const [groupBaselineGrid,setGroupBaselineGrid]=useState<boolean[][]>(emptyGrid());
  const [groupScheduleDirty,setGroupScheduleDirty]=useState(false);
  const [lookup,setLookup]=useState("");
  const [profile,setProfile]=useState<{username:string;standard:boolean[][];custom:boolean[][];hasCustom:boolean;groups:Layer[]}|null>(null);

  const [busy,setBusy]=useState(false);
  const scheduleLoadRequest=useRef(0);
  const overviewLoadRequest=useRef(0);
  const flashError=(e:unknown)=>setError(e instanceof Error?e.message:"Something went wrong.");
  useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem("availability-theme",theme);},[theme]);
  const loadMe=useCallback(async()=>{try{const r=await api<{user:User|null}>("/api/auth/me");setUser(r.user);}catch{}},[]);
  const loadSchedule=useCallback(async()=>{if(!user)return;const request=++scheduleLoadRequest.current;try{
    const weekly=await api<{slots:Slot[]}>("/api/schedule/standard");
    const weeklyGrid=toGrid(weekly.slots);
    const regularLayers=await Promise.all(groups.map(async group=>{
      const layer=await api<{slots:Slot[];locked?:Slot[]}>(`/api/schedule/group/${group.id}/standard`);
      return {id:group.id,name:group.name,color:group.color,grid:toGrid(layer.slots),baseline:toGrid(layer.slots),...(layer.locked?{locked:toGrid(layer.locked)}:{})};
    }));
    if(saveScope==="biweekly"){
      const r=await api<{everyone:Slot[];groups:LayerPayload[];anchorWeekStart:string|null}>(`/api/schedule/biweekly/${dateKey(week)}`);
      if(request!==scheduleLoadRequest.current)return;
      const nextLayers=toLayers(r.groups).map(layer=>({...layer,baseline:regularLayers.find(base=>base.id===layer.id)?.grid||emptyGrid(),locked:regularLayers.find(base=>base.id===layer.id)?.locked||layer.locked}));
      setBaseGrid(weeklyGrid);setGrid(toGrid(r.everyone));setScheduleLayers(nextLayers);setBiweeklyAnchorWeekStart(r.anchorWeekStart);setDirty(false);return;
    }
    const r=saveScope==="weekly"?weekly:await api<{slots:Slot[]}>("/api/schedule/custom/"+dateKey(week));
    const next=toGrid(r.slots);
    const nextLayers=await Promise.all(groups.map(async group=>{
      if(saveScope==="weekly")return regularLayers.find(layer=>layer.id===group.id)!;
      const layer=await api<{slots:Slot[];locked?:Slot[]}>(`/api/schedule/group/${group.id}/custom/${dateKey(week)}`);
      const baseline=regularLayers.find(item=>item.id===group.id);
      return {id:group.id,name:group.name,color:group.color,grid:toGrid(layer.slots),baseline:baseline?.grid||emptyGrid(),locked:baseline?.locked||(layer.locked?toGrid(layer.locked):undefined)};
    }));
    if(request!==scheduleLoadRequest.current)return;
    setBaseGrid(weeklyGrid);setGrid(next);setScheduleLayers(nextLayers);setDirty(false);
  }catch(e){if(request===scheduleLoadRequest.current)flashError(e);}},[user,week,saveScope,groups]);
  const loadGroups=useCallback(async()=>{if(!user)return;try{const r=await api<{groups:Group[]}>("/api/groups");setGroups(current=>{const unchanged=current.length===r.groups.length&&r.groups.every((group,index)=>{const previous=current[index];return previous?.id===group.id&&previous.name===group.name&&previous.color===group.color&&previous.owner.id===group.owner.id&&previous.members.map(member=>member.id).join(",")===group.members.map(member=>member.id).join(",");});return unchanged?current:r.groups;});setSelectedGroup(current=>r.groups.some(group=>group.id===current)?current:(r.groups[0]?.id||""));}catch(e){flashError(e);}},[user]);
  useEffect(()=>{loadMe();const params=new URLSearchParams(location.search);if(params.has("token")){setForm(f=>({...f,token:params.get("token")||""}));setMode("reset");}},[loadMe]);
  useEffect(()=>{loadSchedule();},[loadSchedule]);
  const loadOverview=useCallback(async()=>{if(!user)return;const request=++overviewLoadRequest.current;try{const r=await api<{everyone:Slot[];groups:LayerPayload[]}>(`/api/schedule/layers/${dateKey(week)}`);if(request!==overviewLoadRequest.current)return;setOverviewGrid(toGrid(r.everyone));setOverviewLayers(toLayers(r.groups));}catch(e){if(request===overviewLoadRequest.current)flashError(e);}},[user,week]);
  useEffect(()=>{if(page==="my-schedule")loadOverview();},[page,loadOverview]);
  useEffect(()=>{
    loadGroups();
    if(page!=="groups"&&page!=="edit-schedule")return;
    const refresh=()=>{if(document.visibilityState==="visible")loadGroups();};
    window.addEventListener("focus",refresh);
    const interval=window.setInterval(refresh,30000);
    return ()=>{window.removeEventListener("focus",refresh);window.clearInterval(interval);};
  },[page,loadGroups]);
  useEffect(()=>{const group=groups.find(g=>g.id===selectedGroup);if(group)setGroupColor(group.color);},[groups,selectedGroup]);
  useEffect(()=>{if(page!=="groups"||!selectedGroup||!user)return;api<{slots:GroupSlot[];members:string[]}>(`/api/groups/${selectedGroup}/schedule/${dateKey(week)}`).then(r=>{setGroupSlots(r.slots);setGroupMembers(r.members);}).catch(flashError);},[page,selectedGroup,week,user]);
  useEffect(()=>{if(page!=="groups"||!selectedGroup||!user)return;let cancelled=false;const load=async()=>{try{
    const [weekly, effective] = await Promise.all([
      api<{slots:Slot[]}>(`/api/schedule/group/${selectedGroup}/standard`),
      groupSaveScope==="weekly"
        ? api<{slots:Slot[]}>(`/api/schedule/group/${selectedGroup}/standard`)
        : groupSaveScope==="biweekly"
          ? api<{groups:LayerPayload[];anchorWeekStart:string|null}>(`/api/schedule/biweekly/${dateKey(week)}`).then(result=>{setBiweeklyAnchorWeekStart(result.anchorWeekStart);return {slots:result.groups.find(layer=>layer.id===selectedGroup)?.slots||[]};})
          : api<{slots:Slot[]}>(`/api/schedule/group/${selectedGroup}/custom/${dateKey(week)}`)
    ]);
    if(cancelled)return;
    setGroupBaselineGrid(toGrid(weekly.slots));
    setGroupAssignmentGrid(toGrid(effective.slots));
    setGroupScheduleDirty(false);
  }catch(e){if(!cancelled)flashError(e);}};
  void load();return()=>{cancelled=true;};
  },[page,selectedGroup,groupSaveScope,week,user]);
  const mutateGrid=(g:boolean[][])=>{
    setGrid(g);
    setDirty(true);
  };
  const mutateGroupAssignment=(g:boolean[][])=>{setGroupAssignmentGrid(g);setGroupScheduleDirty(true);};
  const selectedGroupData=groups.find(g=>g.id===selectedGroup);
  const isSelectedGroupOwner=selectedGroupData?.owner.id===user?.id;
  const groupPeople=selectedGroupData?[selectedGroupData.owner,...selectedGroupData.members.filter(member=>member.id!==selectedGroupData.owner.id)]:[];
  const groupAvailabilityPreview=useMemo(()=>{const preview=emptyGrid();for(const item of groupSlots)if(item.status==="green"||item.groupOnly)preview[item.day][item.slot]=true;return preview;},[groupSlots]);
  const saveSchedule=async()=>{setBusy(true);setError("");setMessage("");try{
    if(saveScope==="biweekly"){
      const r=await api<{anchorWeekStart:string;parity:number}>(`/api/schedule/biweekly/${dateKey(week)}`,{method:"PUT",body:JSON.stringify({everyone:toSlots(grid),groups:[]})});
      setBiweeklyAnchorWeekStart(r.anchorWeekStart);
    } else if(saveScope==="weekly"){
      await api("/api/schedule/standard",{method:"PUT",body:JSON.stringify({slots:toSlots(grid)})});
    } else {
      await api(`/api/schedule/custom/${dateKey(week)}`,{method:"PUT",body:JSON.stringify({slots:toSlots(grid)})});
    }
    await loadSchedule();setDirty(false);setMessage(saveScope==="biweekly"?`Changes will repeat every other week, starting ${biweeklyAnchorWeekStart||dateKey(week)}.`:(saveScope==="weekly"?"Changes will repeat every week.":"Changes saved for the selected week only."));
  }catch(e){flashError(e);}finally{setBusy(false);}};
  const clearScheduleOverrides=async()=>{
    if(saveScope==="weekly"||busy)return;
    const description=saveScope==="biweekly"?"Remove all every-other-week overrides? The regular weekly schedule will apply again.":`Remove the specific-week overrides for ${weekLabel}? The regular weekly schedule will apply again.`;
    if(!window.confirm(description))return;
    setBusy(true);setError("");setMessage("");
    try{
      const path=saveScope==="biweekly"?`/api/schedule/biweekly/${dateKey(week)}`:`/api/schedule/custom/${dateKey(week)}`;
      await api(path,{method:"DELETE"});
      await loadSchedule();setDirty(false);
      setMessage(saveScope==="biweekly"?"Every-other-week overrides cleared.":`Overrides for ${weekLabel} cleared.`);
    }catch(e){flashError(e);}finally{setBusy(false);}
  };
  const saveGroupSchedule=async()=>{if(!selectedGroup||!isSelectedGroupOwner)return;setBusy(true);setError("");setMessage("");try{
    const path=groupSaveScope==="weekly"
      ?`/api/schedule/group/${selectedGroup}/standard`
      :groupSaveScope==="biweekly"
        ?`/api/schedule/group/${selectedGroup}/biweekly/${dateKey(week)}`
        :`/api/schedule/group/${selectedGroup}/custom/${dateKey(week)}`;
    await api(path,{method:"PUT",body:JSON.stringify({slots:toSlots(groupAssignmentGrid)})});
    setGroupScheduleDirty(false);
    setMessage(groupSaveScope==="weekly"?`Weekly availability for ${selectedGroupData?.name||"the group"} saved.`:groupSaveScope==="biweekly"?`Every-other-week availability for ${selectedGroupData?.name||"the group"} saved.`:`Availability for ${selectedGroupData?.name||"the group"} saved for ${weekLabel}.`);
    if(groupSaveScope==="biweekly"){
      const result=await api<{groups:LayerPayload[]}>(`/api/schedule/biweekly/${dateKey(week)}`);
      setGroupAssignmentGrid(toGrid(result.groups.find(layer=>layer.id===selectedGroup)?.slots||[]));
    }else{
      const result=await api<{slots:Slot[]}>(groupSaveScope==="weekly"?`/api/schedule/group/${selectedGroup}/standard`:`/api/schedule/group/${selectedGroup}/custom/${dateKey(week)}`);
      setGroupAssignmentGrid(toGrid(result.slots));
    }
    await loadGroups();
    const shared=await api<{slots:GroupSlot[];members:string[]}>(`/api/groups/${selectedGroup}/schedule/${dateKey(week)}`);
    setGroupSlots(shared.slots);setGroupMembers(shared.members);
  }catch(e){flashError(e);}finally{setBusy(false);}};
  const clearGroupOverrides=async()=>{if(!selectedGroup||!isSelectedGroupOwner||groupSaveScope==="weekly"||busy)return;
    const description=groupSaveScope==="biweekly"?`Remove all every-other-week assignments for ${selectedGroupData?.name||"this group"}?`:`Remove the specific-week assignment for ${weekLabel}?`;
    if(!window.confirm(description))return;
    setBusy(true);setError("");setMessage("");try{
      if(groupSaveScope==="biweekly")await api(`/api/schedule/biweekly/${dateKey(week)}`,{method:"DELETE",body:JSON.stringify({groupId:selectedGroup})});
      else await api(`/api/schedule/group/${selectedGroup}/custom/${dateKey(week)}`,{method:"DELETE"});
      setGroupScheduleDirty(false);
      if(groupSaveScope==="biweekly"){
        const result=await api<{groups:LayerPayload[]}>(`/api/schedule/biweekly/${dateKey(week)}`);
        setGroupAssignmentGrid(toGrid(result.groups.find(layer=>layer.id===selectedGroup)?.slots||[]));
      }else{
        const result=await api<{slots:Slot[]}>(`/api/schedule/group/${selectedGroup}/custom/${dateKey(week)}`);
        setGroupAssignmentGrid(toGrid(result.slots));
      }
      setMessage(groupSaveScope==="biweekly"?"All every-other-week group assignments cleared.":`The ${weekLabel} group assignment was cleared.`);
      await loadGroups();
      const shared=await api<{slots:GroupSlot[];members:string[]}>(`/api/groups/${selectedGroup}/schedule/${dateKey(week)}`);
      setGroupSlots(shared.slots);setGroupMembers(shared.members);
    }catch(e){flashError(e);}finally{setBusy(false);}
  };
  const authSubmit=async(e:React.FormEvent)=>{e.preventDefault();setError("");setMessage("");setBusy(true);try{
    if(mode==="login"||mode==="register"){const r=await api<{user:User}>(`/api/auth/${mode}`,{method:"POST",body:JSON.stringify({username:form.username,email:form.email,password:form.password})});setUser(r.user);setPage("my-schedule");setMessage(mode==="register"?"Account created. Start by setting your availability.":"Welcome back.");}
    else if(mode==="forgot"){const r=await api<{message:string}>("/api/auth/forgot-password",{method:"POST",body:JSON.stringify({email:form.email})});setMessage(r.message);}
    else {const r=await api<{message:string}>("/api/auth/reset-password",{method:"POST",body:JSON.stringify({token:form.token,password:form.password})});setMessage(r.message);setMode("login");}
  }catch(e){flashError(e);}finally{setBusy(false);}};
  const createGroup=async(e:React.FormEvent)=>{e.preventDefault();try{const r=await api<{group:{id:string;name:string}}>("/api/groups",{method:"POST",body:JSON.stringify({name:groupName})});setGroupName("");changeSelectedGroup(r.group.id);await loadGroups();setMessage("Group created.");}catch(e){flashError(e);}};
  const addMember=async(e:React.FormEvent,groupId:string)=>{e.preventDefault();try{await api(`/api/groups/${groupId}/members`,{method:"POST",body:JSON.stringify({username:memberNames[groupId]})});setMemberNames(p=>({...p,[groupId]:""}));await loadGroups();setMessage("Member added.");}catch(e){flashError(e);}};
  const removeMember=async(groupId:string,member:User)=>{const group=groups.find(g=>g.id===groupId);const isOwner=group?.owner.id===user?.id;const leavingSelf=!isOwner&&member.id===user?.id;if(!group||(!isOwner&&!leavingSelf)||!window.confirm(leavingSelf?`Leave ${group.name}?`:`Remove ${member.username} from ${group.name}?`))return;setBusy(true);setError("");try{await api(`/api/groups/${groupId}/members/${member.id}`,{method:"DELETE"});await loadGroups();if(leavingSelf){setGroupSlots([]);setGroupMembers([]);setGroupScheduleDirty(false);setMessage(`You left ${group.name}.`);}else{const r=await api<{slots:GroupSlot[];members:string[]}>(`/api/groups/${groupId}/schedule/${dateKey(week)}`);setGroupSlots(r.slots);setGroupMembers(r.members);setMessage(`${member.username} removed from ${group.name}.`);}}catch(e){flashError(e);}finally{setBusy(false);}};
  const deleteGroup=async(group:Group)=>{if(!window.confirm(`Delete "${group.name}" and all of its shared availability? This cannot be undone.`))return;setBusy(true);setError("");try{await api(`/api/groups/${group.id}`,{method:"DELETE"});const r=await api<{groups:Group[]}>("/api/groups");setGroups(r.groups);setSelectedGroup(r.groups[0]?.id||"");setGroupSlots([]);setGroupMembers([]);setGroupScheduleDirty(false);setMessage(`${group.name} deleted.`);}catch(e){flashError(e);}finally{setBusy(false);}};
  const saveGroupColor=async(e:React.FormEvent,groupId:string)=>{e.preventDefault();setBusy(true);setError("");try{const r=await api<{group:{id:string;color:string}}>(`/api/groups/${groupId}`,{method:"PATCH",body:JSON.stringify({color:groupColor})});setGroups(current=>current.map(group=>group.id===groupId?{...group,color:r.group.color}:group));setScheduleLayers(current=>current.map(layer=>layer.id===groupId?{...layer,color:r.group.color}:layer));setOverviewLayers(current=>current.map(layer=>layer.id===groupId?{...layer,color:r.group.color}:layer));setMessage("Group color updated.");}catch(e){flashError(e);}finally{setBusy(false);}};
  const loadProfile=useCallback(async(username:string)=>{const r=await api<{user:{username:string};standard:Slot[];custom:Slot[];hasCustom:boolean;groups:LayerPayload[]}>(`/api/users/${encodeURIComponent(username)}/schedule/${dateKey(week)}`);setProfile({username:r.user.username,standard:toGrid(r.standard),custom:toGrid(r.custom),hasCustom:r.hasCustom,groups:toLayers(r.groups)});},[week]);
  const openMemberProfile=async(username:string)=>{setLookup(username);setProfile(null);setError("");setPage("people");try{await loadProfile(username);}catch(e){flashError(e);}};
  useEffect(()=>{if(page==="people"&&profile?.username&&user)void loadProfile(profile.username).catch(flashError);},[page,week,user,profile?.username,loadProfile]);
  const viewProfile=async(e:React.FormEvent)=>{e.preventDefault();setError("");try{await loadProfile(lookup);}catch(e){flashError(e);}};
  const weekLabel=useMemo(()=>{const end=new Date(week);end.setDate(end.getDate()+6);return `${week.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})} – ${end.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}`;},[week]);
  const isCurrentWeek=dateKey(week)===dateKey(mondayOf(new Date()));
  const shiftWeek=(n:number)=>setWeek(w=>{const next=new Date(w);next.setDate(next.getDate()+n*7);next.setHours(0,0,0,0);return mondayOf(next);});
  const changeSaveScope=(next:"weekly"|"biweekly"|"week")=>{if(next===saveScope)return;if(dirty&&!window.confirm("Discard your unsaved changes and switch schedule scope?"))return;setSaveScope(next);};
  const changeGroupSaveScope=(next:"weekly"|"biweekly"|"week")=>{if(next===groupSaveScope)return;if(groupScheduleDirty&&!window.confirm("Discard unsaved group availability and switch schedule scope?"))return;setGroupSaveScope(next);};
  const changeSelectedGroup=(next:string)=>{if(next===selectedGroup)return;if(groupScheduleDirty&&!window.confirm("Discard unsaved group assignments and switch groups?"))return;setGroupScheduleDirty(false);setSelectedGroupView("calendar");setSelectedGroup(next);};
  const changeGroupWeek=(next:Date)=>{if(groupScheduleDirty&&!window.confirm("Discard unsaved group assignments and change weeks?"))return;setGroupScheduleDirty(false);setWeek(next);};
  const selectGroupWeek=(value:string)=>{if(!value)return;const chosen=new Date(`${value}T00:00:00`);if(Number.isNaN(chosen.getTime()))return;changeGroupWeek(mondayOf(chosen));};
  const shiftGroupWeek=(n:number)=>{const next=new Date(week);next.setDate(next.getDate()+n*7);next.setHours(0,0,0,0);changeGroupWeek(mondayOf(next));};
  const logout=async()=>{try{await api("/api/auth/logout",{method:"POST"});}finally{setUser(null);setGroups([]);setPage("my-schedule");}};
  if(!user) return <main className="auth-page"><button className="theme-toggle auth-theme-toggle" type="button" onClick={()=>setTheme(current=>current==="dark"?"light":"dark")} aria-label={`Switch to ${theme==="dark"?"light":"dark"} mode`} title={`Switch to ${theme==="dark"?"light":"dark"} mode`}><span aria-hidden="true">{theme==="dark"?"☀":"☾"}</span><span>{theme==="dark"?"Light":"Dark"}</span></button><div className="auth-brand"><div className="brand-mark">ct</div><span>commontime</span></div><section className="auth-card"><div className="eyebrow">YOUR TIME, IN SYNC</div><h1>{mode==="register"?"Create your account":mode==="forgot"?"Recover your account":mode==="reset"?"Choose a new password":"Make time together."}</h1><p className="muted">{mode==="register"?"Create a schedule and coordinate with your people.":mode==="forgot"?"Enter your email and we’ll send recovery instructions if the account exists.":mode==="reset"?"Choose a strong new password to secure your account.":"Sign in to see when everyone is free."}</p>
    <form onSubmit={authSubmit} className="auth-form">{(mode==="login"||mode==="register")&&<label>Username<input required minLength={3} maxLength={24} value={form.username} onChange={e=>setForm({...form,username:e.target.value})} autoComplete="username" placeholder="your_username"/></label>}{(mode==="register"||mode==="forgot")&&<label>Email address<input required type="email" maxLength={254} value={form.email} onChange={e=>setForm({...form,email:e.target.value})} autoComplete="email" placeholder="you@example.com"/></label>}{(mode==="login"||mode==="register"||mode==="reset")&&<label>{mode==="reset"?"New password":"Password"}<input required minLength={mode==="login"?1:12} type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} autoComplete={mode==="login"?"current-password":"new-password"} placeholder={mode==="login"?"Your password":"At least 12 characters"}/></label>}{mode==="reset"&&<label>Reset token<input required value={form.token} onChange={e=>setForm({...form,token:e.target.value})}/></label>}<button className="primary-button" disabled={busy}>{busy?"Please wait…":mode==="login"?"Sign in":mode==="register"?"Create account":mode==="forgot"?"Send recovery instructions":"Reset password"}</button></form>
    {message&&<div className="notice success">{message}{mode==="forgot"&&<small>In local development, check the API terminal for the reset link.</small>}</div>}{error&&<div className="notice error">{error}</div>}
    <div className="auth-links">{mode==="login"&&<><button onClick={()=>setMode("register")}>Create an account</button><button onClick={()=>setMode("forgot")}>Forgot password?</button></>}{mode!=="login"&&<button onClick={()=>{setMode("login");setError("");}}>Back to sign in</button>}</div><div className="security-note"><span>♢</span> Passwords are securely hashed. Recovery links expire after 30 minutes.</div></section><footer>Plan less. Be there more.</footer></main>;
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">ct</div><span>commontime</span></div><div className="workspace-label">WORKSPACE</div><nav><button className={page==="my-schedule"?"nav-item active":"nav-item"} onClick={()=>setPage("my-schedule")}><span>▦</span> My schedule</button><button className={page==="edit-schedule"?"nav-item active":"nav-item"} onClick={()=>setPage("edit-schedule")}><span>✎</span> Edit schedule</button><button className={page==="people"?"nav-item active":"nav-item"} onClick={()=>setPage("people")}><span>◎</span> People</button><button className={page==="groups"?"nav-item active":"nav-item"} onClick={()=>setPage("groups")}><span>♧</span> Groups <span className="nav-count">{groups.length}</span></button></nav><div className="sidebar-bottom"><div className="avatar">{user.username.slice(0,1).toUpperCase()}</div><div className="user-details"><strong>{user.username}</strong><span>Personal workspace</span></div><button className="icon-button" onClick={logout} title="Sign out">↗</button></div></aside>
    <main className="main-content"><header className="topbar"><div><span className="breadcrumb">Workspace</span><span className="crumb-sep">/</span><strong>{page==="my-schedule"?"My schedule":page==="edit-schedule"?"Edit schedule":page==="people"?"People":"Groups"}</strong></div><div className="topbar-actions"><button className="theme-toggle" type="button" onClick={()=>setTheme(current=>current==="dark"?"light":"dark")} aria-label={`Switch to ${theme==="dark"?"light":"dark"} mode`} title={`Switch to ${theme==="dark"?"light":"dark"} mode`}><span aria-hidden="true">{theme==="dark"?"☀":"☾"}</span><span>{theme==="dark"?"Light":"Dark"}</span></button><div className="top-user"><span className="online-dot"/>{user.username}</div></div></header>
    <div className="content-wrap">
      {page==="my-schedule"&&<><div className="page-heading"><div><div className="eyebrow">YOUR AVAILABILITY</div><h1>My schedule</h1><p className="muted">View your availability across all seven days. To make changes, open Edit schedule.</p></div></div>
        <div className="schedule-card"><div className="card-head"><div><div className="section-kicker">WEEK AT A GLANCE</div><h2>Your availability</h2><p>Read-only overview of your effective schedule for the selected week.</p></div></div>
        <div className={`week-control ${isCurrentWeek?"current-week":""}`}><button className="arrow-button" onClick={()=>shiftWeek(-1)} aria-label="Previous week">‹</button><div><strong>{weekLabel}</strong><span>Selected week</span></div><button className="arrow-button" onClick={()=>shiftWeek(1)} aria-label="Next week">›</button><button className="today-button" onClick={()=>setWeek(mondayOf(new Date()))}>This week</button></div>
        <WeeklyOverview grid={overviewGrid} layers={overviewLayers}/>
        <div className="card-footer"><span className="saved"><span className="status-dot"/>Read-only view</span><button className="primary-button" onClick={()=>setPage("edit-schedule")}>Edit schedule ↗</button></div></div>
      </>}
      {page==="edit-schedule"&&<><div className="page-heading"><div><div className="eyebrow">YOUR AVAILABILITY</div><h1>Edit your schedule</h1><p className="muted">Set your usual hours, then adjust any specific week.</p></div><div className="heading-date"><span className="calendar-icon">▦</span><div><strong>{saveScope==="weekly"?"Recurring weekly hours":saveScope==="biweekly"?"Every other week":weekLabel}</strong><span>{saveScope==="weekly"?"Repeats every week":saveScope==="biweekly"?`Baseline ${biweeklyAnchorWeekStart||dateKey(week)}`:"Selected week"}</span></div></div></div>
        <div className="schedule-card"><div className="card-head"><div><div className="section-kicker">SCHEDULE SETTINGS</div><h2>Your weekly hours</h2><p>Click and drag across 15-minute blocks to set availability. Group reservations are managed from Groups.</p></div></div>
        <div className="apply-changes scope-control"><strong>Apply edits to</strong><div className="segmented"><button className={saveScope==="weekly"?"selected":""} onClick={()=>changeSaveScope("weekly")}>Every week</button><button className={saveScope==="biweekly"?"selected":""} onClick={()=>changeSaveScope("biweekly")}>Every other week</button><button className={saveScope==="week"?"selected":""} onClick={()=>changeSaveScope("week")}>A specific week</button></div>{saveScope!=="weekly"&&<button type="button" className="mini-button clear-overrides-button" disabled={busy} onClick={clearScheduleOverrides}>{busy?"Clearing…":saveScope==="biweekly"?"Clear all every-other-week overrides":"Clear this week's overrides"}</button>}<p>{saveScope==="weekly"?"Your edits update your recurring schedule. No week selection is needed.":saveScope==="biweekly"?`Your edits repeat every other week, using ${biweeklyAnchorWeekStart||dateKey(week)} as the baseline.`:"Choose a week below. Your edits will apply only to that week."}</p></div>
        {saveScope!=="weekly"&&<div className={`week-control ${isCurrentWeek?"current-week":""}`}><button className="arrow-button" onClick={()=>shiftWeek(-1)} aria-label="Previous week">‹</button><div><strong>{weekLabel}</strong><span>{saveScope==="biweekly"?"Baseline / alternating week":"Editing this week only"}</span></div><button className="arrow-button" onClick={()=>shiftWeek(1)} aria-label="Next week">›</button><button className="today-button" onClick={()=>setWeek(mondayOf(new Date()))}>This week</button></div>}
        <ScheduleGrid grid={grid} baselineGrid={baseGrid} layers={scheduleLayers} editable scope={saveScope} onChange={mutateGrid}/>
        
        <div className="card-footer"><span className={dirty?"unsaved":"saved"}><span className="status-dot"/>{dirty?"Unsaved changes":"All changes saved"}</span><button className="primary-button save-button" disabled={!dirty||busy} onClick={saveSchedule}>{busy?"Saving…":"Save schedule"} <span>↗</span></button></div></div>
      </>}
      {page==="people"&&<><div className="page-heading"><div><div className="eyebrow">YOUR NETWORK</div><h1>See their time.</h1><p className="muted">Look up a username to see their availability for the selected week.</p></div></div><form className="search-card" onSubmit={viewProfile}><div className="search-symbol">⌕</div><input placeholder="Search by username…" value={lookup} onChange={e=>setLookup(e.target.value)} required/><button className="primary-button">View profile</button></form>{profile&&<div className="schedule-card"><div className="card-head"><div><div className="section-kicker">MEMBER PROFILE</div><h2><span className="avatar small">{profile.username[0].toUpperCase()}</span> {profile.username}</h2><p>Availability for the selected week. Group colours show all their scheduled sessions.</p></div></div><div className={`week-control ${isCurrentWeek?"current-week":""}`}><button className="arrow-button" onClick={()=>shiftWeek(-1)} aria-label="Previous week">‹</button><strong>{weekLabel}</strong><button className="arrow-button" onClick={()=>shiftWeek(1)} aria-label="Next week">›</button><button className="today-button" onClick={()=>setWeek(mondayOf(new Date()))}>This week</button></div><WeeklyOverview grid={profile.custom} layers={profile.groups}/></div>}</>}
      {page==="groups"&&<><div className="page-heading"><div><div className="eyebrow">BETTER TOGETHER</div><h1>Find your overlap.</h1><p className="muted">Bring your people together and spot a time that works for everyone.</p></div></div><div className="groups-layout"><section className="schedule-card group-list"><div className="card-head"><div><div className="section-kicker">YOUR CIRCLES</div><h2>Groups</h2></div><span className="count-pill">{groups.length}</span></div><form className="create-group" onSubmit={createGroup}><input placeholder="New group name…" value={groupName} onChange={e=>setGroupName(e.target.value)} required maxLength={60}/><button className="primary-button">+ Create</button></form>{groups.length===0&&<div className="empty-state"><div>♧</div><strong>Your people, all in one place.</strong><p>Create a group, then add members by username.</p></div>}{groups.map(g=><button key={g.id} className={`group-row ${selectedGroup===g.id?"active":""}`} onClick={()=>changeSelectedGroup(g.id)}><span className="group-icon" style={{background:g.color,color:"#fff"}}>{g.name.slice(0,1).toUpperCase()}</span><span className="group-row-info"><strong>{g.name}</strong><small>{g.members.length+1} people · owner {g.owner.username}</small></span><span>›</span></button>)}</section>
      <section className="schedule-card group-detail">
        <div className="card-head">
          <div><div className="section-kicker">SHARED CALENDAR</div><h2>{groups.find(g=>g.id===selectedGroup)?.name||"Select a group"}</h2><p>Combined in 15-minute intervals from availability shared with everyone plus this group's own.</p><p className="group-owner">Owner: {groups.find(g=>g.id===selectedGroup)?.owner.username||"Unknown"}</p></div>
          {(()=>{const group=groups.find(g=>g.id===selectedGroup);return group?.owner.id===user.id?<button type="button" className="danger-button" disabled={busy} onClick={()=>deleteGroup(group)}>Delete group</button>:null;})()}
        </div>
        {selectedGroup&&<>
          {groups.find(g=>g.id===selectedGroup)?.owner.id===user.id&&<form className="add-member" onSubmit={e=>addMember(e,selectedGroup)}><input placeholder="Add member by username…" value={memberNames[selectedGroup]||""} onChange={e=>setMemberNames(p=>({...p,[selectedGroup]:e.target.value}))} required/><button className="secondary-button">Add member</button></form>}
          <div className="member-chips">{groupPeople.map(member=><span key={member.id} className="member-chip"><span className="tiny-avatar">{member.username[0].toUpperCase()}</span><button type="button" className="member-profile-link" onClick={()=>openMemberProfile(member.username)}>{member.username}</button>{((isSelectedGroupOwner&&member.id!==selectedGroupData?.owner.id)||(!isSelectedGroupOwner&&member.id===user.id))&&<button type="button" className="remove-member-button" title={isSelectedGroupOwner?`Remove ${member.username}`:"Leave group"} aria-label={isSelectedGroupOwner?`Remove ${member.username} from group`:"Leave group"} disabled={busy} onClick={()=>removeMember(selectedGroup,member)}>×</button>}</span>)}</div>
          {selectedGroupView==="calendar"&&<div className={`week-control ${isCurrentWeek?"current-week":""}`}><button className="arrow-button" onClick={()=>shiftGroupWeek(-1)} aria-label="Previous week">‹</button><strong>{weekLabel}</strong><button className="arrow-button" onClick={()=>shiftGroupWeek(1)} aria-label="Next week">›</button><button className="today-button" onClick={()=>changeGroupWeek(mondayOf(new Date()))}>This week</button></div>}
          {selectedGroupView==="schedule"&&isSelectedGroupOwner&&<div className="group-assignment-editor">
            <div className="card-head"><div><div className="section-kicker">OWNER SCHEDULING</div><h3>Assign time to everyone in {selectedGroupData?.name}</h3><p>Group assignments reserve these times for all members. Members cannot change them from their personal schedules.</p></div></div>
            <div className="apply-changes scope-control"><strong>Apply group time to</strong><div className="segmented"><button className={groupSaveScope==="weekly"?"selected":""} onClick={()=>changeGroupSaveScope("weekly")}>Every week</button><button className={groupSaveScope==="biweekly"?"selected":""} onClick={()=>changeGroupSaveScope("biweekly")}>Every other week</button><button className={groupSaveScope==="week"?"selected":""} onClick={()=>changeGroupSaveScope("week")}>A specific week</button></div>{groupSaveScope!=="weekly"&&<button type="button" className="mini-button clear-overrides-button" disabled={busy} onClick={clearGroupOverrides}>{busy?"Clearing…":groupSaveScope==="biweekly"?"Clear all every-other-week assignments":"Clear this week's assignment"}</button>}<p>{groupSaveScope==="weekly"?"Assignments repeat every week.":groupSaveScope==="biweekly"?`Select a week to choose its alternating schedule${biweeklyAnchorWeekStart?`; anchored at ${biweeklyAnchorWeekStart}`:""}.`:"Select the exact week this assignment should apply to."}</p></div>
            {groupSaveScope!=="weekly"&&<div className={`group-week-picker ${isCurrentWeek?"current-week":""}`}><label htmlFor="group-schedule-week">{groupSaveScope==="biweekly"?"Choose a week to edit its alternating schedule":"Choose the specific week to edit"}</label><div><button type="button" className="arrow-button" onClick={()=>shiftGroupWeek(-1)} aria-label="Previous week">‹</button><input id="group-schedule-week" type="date" value={dateKey(week)} onChange={e=>selectGroupWeek(e.target.value)} aria-describedby="group-week-description"/><button type="button" className="arrow-button" onClick={()=>shiftGroupWeek(1)} aria-label="Next week">›</button><button type="button" className="today-button" onClick={()=>changeGroupWeek(mondayOf(new Date()))}>This week</button></div><small id="group-week-description">{groupSaveScope==="biweekly"?`Editing week of ${weekLabel}. Weeks alternate from ${biweeklyAnchorWeekStart||"the first saved week"}; switching weeks selects the matching alternating schedule.`:`This assignment applies only to the week of ${weekLabel}.`}</small></div>}
            <ScheduleGrid grid={emptyGrid()} baselineGrid={groupBaselineGrid} layers={[{id:selectedGroup,name:selectedGroupData?.name||"Group",color:selectedGroupData?.color||"#5667df",grid:groupAssignmentGrid,baseline:groupBaselineGrid}]} activeGroup={{id:selectedGroup,name:selectedGroupData?.name||"Group",color:selectedGroupData?.color||"#5667df",grid:groupAssignmentGrid,baseline:groupBaselineGrid}} editable scope={groupSaveScope} onChangeGroup={mutateGroupAssignment} previewGrid={groupAvailabilityPreview}/>
            <div className="card-footer"><span className={groupScheduleDirty?"unsaved":"saved"}><span className="status-dot"/>{groupScheduleDirty?"Unsaved group assignments":"Group assignments saved"}</span><button className="primary-button save-button" disabled={!groupScheduleDirty||busy} onClick={saveGroupSchedule}>{busy?"Saving…":"Save group schedule"} <span>↗</span></button></div>
          </div>}
          {selectedGroupView==="calendar"&&<><div className="group-legend"><span><i className="legend-green"/>Everyone free</span><span><i className="legend-red"/>Multiple unavailable</span><span><i className="legend-yellow"/>One unavailable</span><span><i className="legend-group" style={{background:groups.find(g=>g.id===selectedGroup)?.color}}/>Scheduled session</span></div>
          <div className="group-day-grid">{DAYS.map((d,di)=><div className="group-day" key={d}><div className="group-day-name">{d.slice(0,3)}</div><div className="group-day-slots">{Array.from({length:96},(_,s)=>{const item=groupSlots.find(x=>x.day===di&&x.slot===s);const sessionColor=groups.find(g=>g.id===selectedGroup)?.color;return <span key={s} style={item?.groupOnly&&sessionColor?{background:`linear-gradient(to bottom, var(--group-availability-color) 0 50%, ${sessionColor} 50% 100%)`}:undefined} className={`group-slot ${item?.status||"loading"} ${item?.groupOnly?"group-only":""}`} title={`${d} ${labelTime(s)} · ${item?.groupOnly?`Group availability ${item.status}; scheduled session for ${groups.find(g=>g.id===selectedGroup)?.name||"this group"}`:item?.unavailable.length?`Unavailable: ${item.unavailable.join(", ")}`:"Everyone available"}`}/>})}</div></div>)}</div>
          <div className="time-axis group-time-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div></>}
          {isSelectedGroupOwner&&<div className="group-view-tabs" role="tablist" aria-label="Selected group view">
            <button type="button" role="tab" aria-selected={selectedGroupView==="calendar"} className={selectedGroupView==="calendar"?"selected":""} onClick={()=>{if(groupScheduleDirty&&!window.confirm("Discard unsaved group assignments and switch to the calendar?"))return;setGroupScheduleDirty(false);setSelectedGroupView("calendar");}}>Shared calendar</button>
            <button type="button" role="tab" aria-selected={selectedGroupView==="schedule"} className={selectedGroupView==="schedule"?"selected":""} onClick={()=>setSelectedGroupView("schedule")}>Owner scheduling</button>
          </div>}
        </>}
      </section></div></>}
      {page==="groups"&&selectedGroup&&(()=>{const group=groups.find(g=>g.id===selectedGroup);return group?.owner.id===user.id?<form className="group-color-editor" onSubmit={e=>saveGroupColor(e,group.id)}><label htmlFor="group-color">Group color</label><input id="group-color" type="color" value={groupColor} onChange={e=>setGroupColor(e.target.value)} aria-label="Choose group color"/><span>{groupColor.toUpperCase()}</span><button className="secondary-button" disabled={busy||groupColor.toLowerCase()===group.color.toLowerCase()}>Save color</button></form>:null;})()}
      {(message||error)&&<div className={`toast ${error?"toast-error":"toast-success"}`}><span>{error?"!":"✓"}</span>{error||message}<button onClick={()=>{setError("");setMessage("");}}>×</button></div>}
    </div></main></div>;
}
