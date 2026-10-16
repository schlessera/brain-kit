import {expect,test} from "bun:test";
import {markdownFences} from "../src/lib/markdown-code.js";
test("GFM fence extraction uses container-aware parser values and ignores fenced examples",()=>{
 const source=['# The dispatch','','> ```diagram title="voyage"','> title: The voyage','> ```','','- ```diagram','  id: release','  ```','','````markdown','```diagram','this is an example','```','````','','`diagram`'].join('\n');
 const fences=markdownFences(source);expect(fences.map(({language,meta,value,line})=>({language,meta,value,line}))).toEqual([{language:"diagram",meta:'title="voyage"',value:"title: The voyage",line:3},{language:"diagram",meta:"",value:"id: release",line:7},{language:"markdown",meta:"",value:'```diagram\nthis is an example\n```',line:11}]);for(const fence of fences)expect(source.slice(fence.start,fence.end)).toContain('```');
});
