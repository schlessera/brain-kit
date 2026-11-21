import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import ts from "typescript";
test("actual raw CLI credential judge requires API key when both credentials are present",()=>{
 const file=join(import.meta.dir,"../scripts/measure-claude-runtime.ts"),source=ts.createSourceFile(file,readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
 let row:ts.ArrayLiteralExpression|undefined;
 function visit(node:ts.Node){if(ts.isArrayLiteralExpression(node)&&node.elements[0]&&ts.isStringLiteral(node.elements[0] as ts.Node)&&node.elements[0]!.getText(source)==='"both (raw CLI)"')row=node;ts.forEachChild(node,visit);}visit(source);
 expect(row,"RAW_CLI_ROW_LABEL_RESTORED").toBeDefined();
 const js=ts.transpileModule('const judge='+row!.elements[2]!.getText(source)+';return judge;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const key="odysseus-synthetic-key",oauth="odysseus-synthetic-oauth",judge=new Function("API_KEY","OAUTH","sent",js)(key,oauth,(r:{auth:unknown[]})=>r.auth.length>0);
 const account={apiKeySource:"ANTHROPIC_API_KEY",tokenSource:"CLAUDE_CODE_OAUTH_TOKEN",ending:"success"};
 expect(judge({...account,auth:[{xApiKey:key,authorization:null}]}),"RAW_CLI_BOTH_PRESENT_PREFERS_API_KEY").toBeNull();
 expect(judge({...account,auth:[{xApiKey:null,authorization:`Bearer ${oauth}`}]}),"RAW_CLI_MUST_NOT_ENCODE_GUARD_SOCKET_AUTH").not.toBeNull();
 expect(judge({...account,auth:[]}),"RAW_CLI_AUTH_MUST_BE_OBSERVED").not.toBeNull();
});
