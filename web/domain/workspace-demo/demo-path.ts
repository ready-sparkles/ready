const WORKSPACE_DEMO_PATH = "/demo/workspace";
/** Posted by the demo frame once its runtime is ready and the workspace is mounted. */
export const WORKSPACE_DEMO_READY_MESSAGE = "ready-workspace-demo:ready";

export function isWorkspaceDemoPath(pathname: string | null | undefined): boolean {
  return pathname === WORKSPACE_DEMO_PATH || Boolean(pathname?.startsWith(`${WORKSPACE_DEMO_PATH}/`));
}

// Runs before any app script in the demo frame. The frame shares this origin's
// storage with the visitor's real tabs, so demo UI preferences stay in memory.
export const workspaceDemoStorageBootScript = `if(location.pathname===${JSON.stringify(WORKSPACE_DEMO_PATH)}||location.pathname.indexOf(${JSON.stringify(`${WORKSPACE_DEMO_PATH}/`)})===0){try{var m=function(){var d=new Map();return{get length(){return d.size},key:function(i){var k=Array.from(d.keys());return i<k.length?k[i]:null},getItem:function(k){k=String(k);return d.has(k)?d.get(k):null},setItem:function(k,v){d.set(String(k),String(v))},removeItem:function(k){d.delete(String(k))},clear:function(){d.clear()}}};Object.defineProperty(window,'localStorage',{configurable:true,value:m()});Object.defineProperty(window,'sessionStorage',{configurable:true,value:m()})}catch(e){}}`;
