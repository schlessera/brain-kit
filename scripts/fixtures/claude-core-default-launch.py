"""Actual core runner in networkless namespace; no parent credential reads."""
import argparse,pathlib,os,subprocess
p=argparse.ArgumentParser();p.add_argument('--bun',required=True);p.add_argument('--output',required=True);a=p.parse_args()
source=pathlib.Path(__file__).resolve().parents[2];out=pathlib.Path(a.output).resolve();out.mkdir(mode=0o700,parents=True,exist_ok=False)
env={'PATH':str(pathlib.Path(a.bun).parent)+':/usr/bin:/bin','HOME':'/tmp/offline-home','BRAIN_CORE_DEFAULT_OFFLINE':'1'}
cmd=['bwrap','--unshare-all','--die-with-parent','--new-session','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/tmp/offline-home']
for d in ['/usr','/bin','/lib','/lib64','/etc']:
 if pathlib.Path(d).exists():cmd+=['--ro-bind',d,d]
cmd+=['--ro-bind',str(source),str(source),'--ro-bind',str(pathlib.Path(a.bun).parent),str(pathlib.Path(a.bun).parent),'--bind',str(out),str(out),'--chdir',str(source),a.bun,str(source/'scripts/fixtures/claude-core-default-probe.ts'),str(out)]
raise SystemExit(subprocess.run(cmd,env=env,timeout=60).returncode)
