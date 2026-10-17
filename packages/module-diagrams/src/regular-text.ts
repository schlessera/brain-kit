import {closeSync,constants,fstatSync,openSync,readFileSync} from "node:fs";
/** Inspect only a bounded regular leaf; never follow links or wait on a FIFO. */
export function readRegularText(path:string,limit:number):string{
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const info=fstatSync(fd);if(!info.isFile())throw Error("Diagram inspection requires a regular file");if(info.size>limit)throw Error("Diagram inspection exceeds its file size bound");return readFileSync(fd,"utf8");}finally{closeSync(fd);}
}
