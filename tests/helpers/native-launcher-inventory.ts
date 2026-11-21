/** Discover real SDK callers from syntax; never evaluate fixture or runtime code. */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
export function nativeSdkLauncher(source: ts.SourceFile): boolean {
  const apiNames=new Set(["query","prewarm"]),bindings=new Set<string>(),backends=new Set<string>(["createClaudeBackend"]);
  let launches=false;
  function collect(node:ts.Node):void {
    if(ts.isImportDeclaration(node)&&!node.importClause?.isTypeOnly){
      const names=node.importClause?.namedBindings;
      if(names&&ts.isNamedImports(names))for(const item of names.elements)if(!item.isTypeOnly&&(item.propertyName??item.name).text==="createClaudeBackend")backends.add(item.name.text);
      if(ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==="@anthropic-ai/claude-agent-sdk"){
        if(names&&ts.isNamedImports(names))for(const item of names.elements)if(!item.isTypeOnly&&apiNames.has((item.propertyName??item.name).text))bindings.add(item.name.text);
        const namespace=names&&ts.isNamespaceImport(names)?names.name.text:node.importClause?.name?.text;
        if(namespace)for(const api of apiNames)bindings.add(`${namespace}.${api}`);
      }
    }
    if(ts.isVariableDeclaration(node)&&node.initializer&&/await import\(/.test(node.initializer.getText(source))&&source.text.includes("@anthropic-ai/claude-agent-sdk")){
      if(ts.isObjectBindingPattern(node.name))for(const item of node.name.elements)if(apiNames.has((item.propertyName??item.name).getText(source)))bindings.add(item.name.getText(source));
      if(ts.isIdentifier(node.name))for(const api of apiNames)bindings.add(`${node.name.text}.${api}`);
    }
    ts.forEachChild(node,collect);
  }collect(source);
  function typeOrDeclaration(node:ts.Node):boolean {
    for(let parent=node.parent;parent;parent=parent.parent){
      if(ts.isTypeNode(parent)||ts.isImportDeclaration(parent))return true;
      if(ts.isExpression(parent)||ts.isStatement(parent))break;
    }
    const parent=node.parent;
    return Boolean(parent&&((ts.isVariableDeclaration(parent)||ts.isParameter(parent)||ts.isBindingElement(parent))&&parent.name===node||
      ts.isPropertyAssignment(parent)&&parent.name===node||ts.isPropertyAccessExpression(parent)&&parent.name===node));
  }
  function name(node:ts.Node):string {
    if(ts.isElementAccessExpression(node)&&ts.isStringLiteral(node.argumentExpression))return `${node.expression.getText(source)}.${node.argumentExpression.text}`;
    return node.getText(source);
  }
  function visit(node:ts.Node):void {
    // Passing the API to a dispatcher or default parameter can launch just as
    // calling it here can. Import/binding names and type references cannot.
    if((ts.isIdentifier(node)||ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))&&bindings.has(name(node))&&!typeOrDeclaration(node))launches=true;
    if(ts.isCallExpression(node)&&(backends.has(name(node.expression))||name(node.expression).endsWith(".createClaudeBackend"))){
      let config=node.arguments[0];
      while(config&&(ts.isAsExpression(config)||ts.isSatisfiesExpression(config)||ts.isParenthesizedExpression(config)))config=config.expression;
      const injected=config&&ts.isObjectLiteralExpression(config)&&config.properties.some(prop=>(ts.isPropertyAssignment(prop)||ts.isShorthandPropertyAssignment(prop))&&prop.name.getText(source)==="queryFn");
      if(!injected)launches=true;
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
