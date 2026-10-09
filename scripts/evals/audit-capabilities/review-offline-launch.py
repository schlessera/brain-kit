"""No credential reads: actual native SDK review in a fresh networkless namespace."""
import argparse,os,subprocess,pathlib
p=argparse.ArgumentParser();p.add_argument('--bun',required=True);p.add_argument('--output',required=True);p.add_argument('--mode',default='normal');a=p.parse_args()
source=pathlib.Path(__file__).resolve().parents[3]; output=pathlib.Path(a.output).resolve()
if output.exists():raise SystemExit('Fresh output required')
output.mkdir(mode=0o700,parents=True)
env={'PATH':os.path.dirname(a.bun)+':/usr/local/bin:/usr/bin:/bin','HOME':'/tmp/offline-home','BRAIN_AUDIT_REVIEW_OFFLINE':'1'}
cmd=['bwrap','--unshare-all','--die-with-parent','--new-session','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/tmp/offline-home']
for root in ['/usr','/bin','/lib','/lib64','/etc']:
 if pathlib.Path(root).exists():cmd+=['--ro-bind',root,root]
cmd+=['--ro-bind',str(source),str(source),'--ro-bind',str(pathlib.Path(a.bun).parent),str(pathlib.Path(a.bun).parent),'--bind',str(output),str(output),'--chdir',str(source),a.bun,str(source/'scripts/evals/audit-capabilities/review-offline.ts'),str(output/'artifacts'),a.mode]
raise SystemExit(subprocess.run(cmd,env=env).returncode)
