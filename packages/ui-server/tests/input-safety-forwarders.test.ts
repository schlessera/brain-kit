/** Inventory forwarding methods so optional collector arguments cannot disappear. */
import {expect,test} from 'bun:test';
import ts from 'typescript';
import {fileURLToPath} from 'node:url';

 test('every input-safety result wrapper forwards its typed argument tuple intact',async()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url)),found:string[]=[];
 for await(const path of new Bun.Glob('packages/*/src/**/*.ts').scan({cwd:root})){
  const source=ts.createSourceFile(path,await Bun.file(`${root}/${path}`).text(),ts.ScriptTarget.Latest,true);
  const visit=(node:ts.Node)=>{
   const method=ts.isMethodDeclaration(node)&&node.name.getText(source)==='result'?node:
    ts.isPropertyAssignment(node)&&node.name.getText(source)==='result'&&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer))?node.initializer:undefined;
   if(method?.body){
    const calls:ts.CallExpression[]=[];
    const nested=(child:ts.Node)=>{if(ts.isCallExpression(child)&&ts.isPropertyAccessExpression(child.expression)&&child.expression.name.text==='result')calls.push(child);ts.forEachChild(child,nested);};
    nested(method.body);
    if(calls.length){
     found.push(path);
     expect(method.parameters.length,`${path}: wrapper keeps one typed rest tuple`).toBe(1);
     const parameter=method.parameters[0]!;
     expect(parameter.dotDotDotToken,`${path}: rest parameter is mandatory`).toBeDefined();
     expect(parameter.type?.getText(source),`${path}: signature tracks the SDK callback`).toBe('Parameters<InputSafety["result"]>');
     for(const call of calls){
      expect(call.arguments.length,`${path}: no positional forwarding list`).toBe(1);
      expect(ts.isSpreadElement(call.arguments[0]!),`${path}: spread every argument`).toBe(true);
      expect(call.arguments[0]!.getText(source)).toBe(`...${parameter.name.getText(source)}`);
     }
    }
   }
   ts.forEachChild(node,visit);
  };
  visit(source);
 }
 expect(found.sort(),'REVIEW_EVERY_NEW_RESULT_WRAPPER').toEqual(['packages/ui-server/src/brain/turn-extraction.ts']);
 });
