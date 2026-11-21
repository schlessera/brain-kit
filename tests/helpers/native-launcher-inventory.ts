/** Discover real SDK callers from syntax; never evaluate fixture or runtime code. */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
export function nativeSdkLauncher(source: ts.SourceFile): boolean {
  const queries=new Set<string>(),backends=new Set<string>(["createClaudeBackend"]);let launches=false;
  function bindings(node:ts.Node):void {
    if(ts.isImportDeclaration(node)){
      const names=node.importClause?.namedBindings;
      if(names&&ts.isNamedImports(names))for(const item of names.elements)if(!item.isTypeOnly&&(item.propertyName??item.name).text==="createClaudeBackend")backends.add(item.name.text);
    }
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==="@anthropic-ai/claude-agent-sdk"&&!node.importClause?.isTypeOnly){
      const names=node.importClause?.namedBindings;
      if(names&&ts.isNamespaceImport(names))queries.add(`${names.name.text}.query`);
      if(node.importClause?.name)queries.add(`${node.importClause.name.text}.query`);
      if(names&&ts.isNamedImports(names))for(const item of names.elements)if(!item.isTypeOnly&&(item.propertyName??item.name).text==="query")queries.add(item.name.text);
    }
    if(ts.isVariableDeclaration(node)&&ts.isObjectBindingPattern(node.name)&&node.initializer&&/await import\(/.test(node.initializer.getText(source))&&source.text.includes("@anthropic-ai/claude-agent-sdk")){
      for(const item of node.name.elements)if((item.propertyName??item.name).getText(source)==="query")queries.add(item.name.getText(source));
    }
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&/await import\(/.test(node.initializer.getText(source))&&source.text.includes("@anthropic-ai/claude-agent-sdk"))queries.add(`${node.name.text}.query`);
    ts.forEachChild(node,bindings);
  }bindings(source);
  function visit(node:ts.Node):void {
    if(ts.isCallExpression(node)){
      let name=node.expression.getText(source);
      if(ts.isElementAccessExpression(node.expression)&&node.expression.argumentExpression&&ts.isStringLiteral(node.expression.argumentExpression))name=`${node.expression.expression.getText(source)}.${node.expression.argumentExpression.text}`;
      if(queries.has(name))launches=true;
      if((backends.has(name)||name.endsWith(".createClaudeBackend"))&&source.text.includes(".startTurn(")&&!/mockWorkerHostForSdkStream|mock\.module|mock\.method|queryFn|claudeCodePath/.test(source.text)){
        const config=node.arguments[0];
        if(config&&ts.isObjectLiteralExpression(config)&&!config.properties.some(prop=>(ts.isPropertyAssignment(prop)||ts.isShorthandPropertyAssignment(prop))&&prop.name.getText(source)==="queryFn"))launches=true;
      }
    }
    ts.forEachChild(node,visit);
  }visit(source);return launches;
}
export function fixtureSources(root:string): Map<string,ts.SourceFile> {
  const files=new Set<string>();
  for(const pattern of ["packages/*/tests/**/*.ts","scripts/**/*.ts","tests/**/*.ts","experiments/**/*.ts"])
    for(const file of new Bun.Glob(pattern).scanSync({cwd:root}))files.add(file);
  const sources=new Map<string,ts.SourceFile>();
  for(const file of [...files].sort()){
    const text=readFileSync(join(root,file),"utf8");
    if(/@anthropic-ai\/claude-agent-sdk|createClaudeBackend|nativeNamespaceEnvironment/.test(text))sources.set(file,ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true));
  }
  return sources;
}
export function namespaceLaunches(source:ts.SourceFile): ts.ArrayLiteralExpression[] {
 const plans:ts.ArrayLiteralExpression[]=[];
 function visit(node:ts.Node):void {
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&["spawn","spawnSync"].includes(node.expression.name.text)){
   const argv=node.arguments[0];
   if(argv&&ts.isArrayLiteralExpression(argv)&&argv.elements.some(item=>ts.isSpreadElement(item)&&item.expression.getText(source)==="nativeNamespaceEnvironment()"))plans.push(argv);
  }
  ts.forEachChild(node,visit);
 }visit(source);return plans;
}
