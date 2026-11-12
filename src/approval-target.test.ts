import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,mkdir,symlink,writeFile,readFile,rename,rm,realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../index.js";
import {createComputerUseTool} from "./plugin-tool.js";
import { COMPUTER_USE_TOOL_NAME } from "./tool-names.js";

function hook(context: any) { let handler:any; plugin.register({id:"opencoven-desktop-use",name:"fixture",source:"test",registrationMode:"full",config:{},runtime:{},logger:console,registerTool(factory:any){factory(context);},on(name:any,value:any){if(name==="before_tool_call")handler=value;}} as never); return handler; }
test("approval identifies a symlink's canonical target before confirmation",async t=>{
 const root=await mkdtemp(join(tmpdir(),"desktopuse-approved-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=join(root,"workspace"),outside=join(root,"secrets");await mkdir(workspace);await mkdir(outside);await symlink(outside,join(workspace,"alias"));
 const result=await hook({workspaceDir:workspace,agentId:"computer-use"})({toolName:COMPUTER_USE_TOOL_NAME,params:{action:"file-write",path:"alias/file",content:"fixture"}},{workspaceDir:workspace,agentId:"computer-use"});
 assert.equal(result.params.path,join(await realpath(outside),"file"));
 assert.ok(result.requireApproval.description.includes(result.params.path));
 assert.ok(result.requireApproval.description.includes("secret-sensitive"));
 assert.equal(result.params.confirm,true);
});
test("execution requires approval again if the canonical parent changes after approval",async t=>{
 const root=await mkdtemp(join(tmpdir(),"desktopuse-rebind-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=join(root,"workspace"),real=join(workspace,"real"),other=join(root,"other");await mkdir(real,{recursive:true});await mkdir(other);await writeFile(join(other,"file"),"unchanged");
 const approved=await hook({workspaceDir:workspace,agentId:"computer-use"})({toolName:COMPUTER_USE_TOOL_NAME,params:{action:"file-write",path:"real/file",content:"new",overwrite:true}},{workspaceDir:workspace});
 await rename(real,join(workspace,"old"));await symlink(other,real);
 const result=await createComputerUseTool({ctx:{workspaceDir:workspace},appendAuditEvent:async()=>{}}).execute("rebind",approved.params);
 assert.equal(result.details.status,"needsApproval");
 assert.equal(await readFile(join(other,"file"),"utf8"),"unchanged");
});
