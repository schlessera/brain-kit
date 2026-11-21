/* Test-only Linux connect broker. No untrusted syscall is continued. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported native test architecture
#endif
#define ERRNO_DENY (SECCOMP_RET_ERRNO | EPERM)
#define BLOCK(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,n,0,1), BPF_STMT(BPF_RET|BPF_K,ERRNO_DENY)
#define NOTIFY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,n,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_USER_NOTIF)
static volatile sig_atomic_t child_pid;
static void forward(int sig) { if (child_pid > 0) kill(child_pid,sig); }
static int install_policy(void) {
  struct sock_filter instructions[] = {
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,NATIVE_ARCH,1,0),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
    /* Reject x32 and other alternate syscall-number ABIs. */
    BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K,0x40000000,0,1),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
    BLOCK(SYS_seccomp), BLOCK(SYS_ptrace), BLOCK(SYS_pidfd_getfd),
    BLOCK(SYS_process_vm_readv), BLOCK(SYS_process_vm_writev),
    BLOCK(SYS_io_uring_setup), BLOCK(SYS_io_uring_register), BLOCK(SYS_io_uring_enter),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_prctl,0,4),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,PR_SET_SECCOMP,0,1),
    BPF_STMT(BPF_RET|BPF_K,ERRNO_DENY),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
    NOTIFY(SYS_connect), NOTIFY(SYS_sendmsg), NOTIFY(SYS_sendmmsg),
    NOTIFY(SYS_bind), NOTIFY(SYS_listen), NOTIFY(SYS_accept), NOTIFY(SYS_accept4),
    /* Connected-stream sendto(NULL) is safe; addressed sends are brokered. */
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_sendto,0,6),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[4])),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,0,0,3),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[4])+4),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,0,0,1),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program={.len=sizeof(instructions)/sizeof(instructions[0]),.filter=instructions};
  if (prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)) return -1;
  return (int)syscall(SYS_seccomp,SECCOMP_SET_MODE_FILTER,SECCOMP_FILTER_FLAG_NEW_LISTENER,&program);
}
static pid_t leader(pid_t tid) {
  char path[64],line[256]; snprintf(path,sizeof(path),"/proc/%d/status",tid);
  FILE *input=fopen(path,"re"); if(!input) return -1;
  int result=-1; while(fgets(line,sizeof(line),input)) if(sscanf(line,"Tgid: %d",&result)==1) break;
  fclose(input); return result;
}
static int duplicate(pid_t tid,int fd) {
  pid_t pid=leader(tid); if(pid<=0) return -1;
  int process=(int)syscall(SYS_pidfd_open,pid,0); if(process<0) return -1;
  int copy=(int)syscall(SYS_pidfd_getfd,process,fd,0); close(process); return copy;
}
static int valid(int listener,uint64_t id) { return ioctl(listener,SECCOMP_IOCTL_NOTIF_ID_VALID,&id)==0; }
static uint64_t *cookies;
static size_t cookie_count;
static int socket_cookie(int fd,uint64_t *cookie) {
  socklen_t size=sizeof(*cookie); return getsockopt(fd,SOL_SOCKET,SO_COOKIE,cookie,&size);
}
static int retain_cookie(int fd) {
  uint64_t cookie=0; if(socket_cookie(fd,&cookie) || cookie_count>=65536) return -1;
  uint64_t *next=realloc(cookies,(cookie_count+1)*sizeof(*cookies)); if(!next) return -1;
  cookies=next; cookies[cookie_count++]=cookie; return 0;
}
static int approved_cookie(int fd) {
  uint64_t cookie=0; if(socket_cookie(fd,&cookie)) return 0;
  for(size_t i=0;i<cookie_count;i++) if(cookies[i]==cookie) return 1;
  return 0;
}
static int read_guest(pid_t pid,void *output,uintptr_t source,size_t size) {
  struct iovec local={output,size},remote={(void *)source,size};
  return process_vm_readv(pid,&local,1,&remote,1,0)==(ssize_t)size;
}
/* Copy connected-stream messages, never continuing mutable caller msghdrs. */
static int send_connected(int listener,struct seccomp_notif *request,int64_t *value) {
  struct msghdr message={0};
  if(!read_guest(request->pid,&message,request->data.args[1],sizeof(message)) || message.msg_name
      || message.msg_namelen || message.msg_control || message.msg_controllen || message.msg_iovlen>1024) return EPERM;
  int flags=(int)request->data.args[2];
  if(flags & ~(MSG_DONTWAIT|MSG_NOSIGNAL|MSG_MORE|MSG_EOR)) return EPERM;
  struct iovec *vectors=calloc(message.msg_iovlen?message.msg_iovlen:1,sizeof(*vectors));
  if(!vectors) return ENOMEM;
  int error=EPERM,fd=-1;size_t copied=0,total=0;
  if(message.msg_iovlen && !read_guest(request->pid,vectors,(uintptr_t)message.msg_iov,message.msg_iovlen*sizeof(*vectors))) goto done;
  for(size_t i=0;i<message.msg_iovlen;i++) {
    size_t size=vectors[i].iov_len;
    if(size>64*1024*1024-total) goto done;
    total+=size; void *source=vectors[i].iov_base;
    vectors[i].iov_base=malloc(size?size:1); if(!vectors[i].iov_base) goto done;
    copied++;
    if(size && !read_guest(request->pid,vectors[i].iov_base,(uintptr_t)source,size)) goto done;
  }
  fd=duplicate(request->pid,(int)request->data.args[0]);
  if(fd<0 || !approved_cookie(fd) || !valid(listener,request->id)) goto done;
  message.msg_iov=vectors; message.msg_name=NULL; message.msg_namelen=0; message.msg_control=NULL; message.msg_controllen=0;
  ssize_t sent=sendmsg(fd,&message,flags); error=sent<0?errno:0; if(sent>=0)*value=sent;
 done:
  if(fd>=0)close(fd);
  for(size_t i=0;i<copied;i++)free(vectors[i].iov_base);
  free(vectors);return error;
}
static int connect_pinned(int listener,struct seccomp_notif *request,int pinned,const char *allowed) {
  size_t length=request->data.args[2],expected=strlen(allowed);
  struct sockaddr_un address={0};
  if(length<offsetof(struct sockaddr_un,sun_path)+expected || length>sizeof(address)) return EPERM;
  struct iovec local={&address,length},remote={(void *)(uintptr_t)request->data.args[1],length};
  if(process_vm_readv(request->pid,&local,1,&remote,1,0)!=(ssize_t)length) return EPERM;
  size_t supplied=length - offsetof(struct sockaddr_un,sun_path);
  size_t actual=strnlen(address.sun_path,supplied);
  if(address.sun_family!=AF_UNIX || actual!=expected || memcmp(address.sun_path,allowed,expected)) return EPERM;
  int socket=duplicate(request->pid,(int)request->data.args[0]); if(socket<0) return EPERM;
  int domain=0,type=0; socklen_t size=sizeof(int);
  if(getsockopt(socket,SOL_SOCKET,SO_DOMAIN,&domain,&size) || getsockopt(socket,SOL_SOCKET,SO_TYPE,&type,&size)
      || domain!=AF_UNIX || type!=SOCK_STREAM || !valid(listener,request->id)) { close(socket); return EPERM; }
  /* The broker connects a duplicate of the blocked socket to a pinned inode.
     It never continues the caller's syscall or trusts caller memory afterward. */
  struct sockaddr_un target={.sun_family=AF_UNIX};
  snprintf(target.sun_path,sizeof(target.sun_path),"/proc/self/fd/%d",pinned);
  int result=connect(socket,(struct sockaddr *)&target,offsetof(struct sockaddr_un,sun_path)+strlen(target.sun_path)+1);
  int error=result==0?0:errno;
  if(!error && retain_cookie(socket)) error=ENOMEM;
  close(socket); return error;
}
static int run(int pinned,const char *allowed,const char *head,char **command,int probe,const char *foreign) {
  int ready[2],ack[2]; if(pipe2(ready,O_CLOEXEC)||pipe2(ack,O_CLOEXEC)) return 125;
  /* Native descendants cannot inspect or change their broker through /proc. */
  if(prctl(PR_SET_DUMPABLE,0)) return 125;
  pid_t child=fork(); if(child<0) return 125;
  if(child==0) {
    close(ready[0]); close(ack[1]);
    if(prctl(PR_SET_PDEATHSIG,SIGKILL)) _exit(125);
    int listener=install_policy(); if(listener<0) _exit(125);
    if(prctl(PR_SET_DUMPABLE,1)) _exit(125);
    if(write(ready[1],&listener,sizeof(listener))!=sizeof(listener)) _exit(125);
    char accepted=0; if(read(ack[0],&accepted,1)!=1 || accepted!=1) _exit(125);
    close(listener); close(ready[1]); close(ack[0]); close(pinned);
    if(probe) {
      struct sockaddr_un target={.sun_family=AF_UNIX}; strcpy(target.sun_path,allowed);
      int fd=socket(AF_UNIX,SOCK_STREAM,0);
      if(fd<0 || connect(fd,(struct sockaddr *)&target,sizeof(target))) _exit(121);
      struct iovec vector={.iov_base="Ithaca",.iov_len=6}; struct msghdr message={.msg_iov=&vector,.msg_iovlen=1};
      if(sendmsg(fd,&message,MSG_NOSIGNAL)!=6) _exit(121);
      close(fd);
      strcpy(target.sun_path,foreign); fd=socket(AF_UNIX,SOCK_STREAM,0);
      if(fd<0 || connect(fd,(struct sockaddr *)&target,sizeof(target))!=-1 || errno!=EPERM) _exit(122);
      close(fd);
      fd=socket(AF_INET,SOCK_STREAM,0);
      if(fd<0 || connect(fd,(struct sockaddr *)&target,sizeof(target))!=-1 || errno!=EPERM) _exit(123);
      close(fd);
      fd=socket(AF_UNIX,SOCK_DGRAM,0);
      if(fd<0 || bind(fd,(struct sockaddr *)&target,sizeof(target))!=-1 || errno!=EPERM) _exit(124);
      if(sendto(fd,"Ithaca",6,0,(struct sockaddr *)&target,sizeof(target))!=-1 || errno!=EPERM) _exit(124);
      close(fd);
      if(prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,NULL)!=-1 || errno!=EPERM) _exit(124);
      if(syscall(SYS_pidfd_getfd,-1,0,0)!=-1 || errno!=EPERM) _exit(124);
      if(syscall(SYS_seccomp,0,0,0)!=-1 || errno!=EPERM) _exit(124);
      _exit(0);
    }
    execvp(command[0],command); _exit(127);
  }
  child_pid=child; close(ready[1]); close(ack[0]);
  int remote=-1,listener=-1;
  if(read(ready[0],&remote,sizeof(remote))==sizeof(remote)) listener=duplicate(child,remote);
  close(ready[0]); char accepted=listener>=0; ssize_t acknowledged=write(ack[1],&accepted,1); close(ack[1]);
  if(acknowledged!=1) { kill(child,SIGKILL); waitpid(child,NULL,0); if(listener>=0) close(listener); return 125; }
  if(listener<0) { kill(child,SIGKILL); waitpid(child,NULL,0); return 125; }
  signal(SIGTERM,forward); signal(SIGINT,forward); signal(SIGHUP,forward);
  struct seccomp_notif_sizes sizes;
  if(syscall(SYS_seccomp,SECCOMP_GET_NOTIF_SIZES,0,&sizes)) { kill(child,SIGKILL); waitpid(child,NULL,0); close(listener); return 125; }
  struct seccomp_notif *request=calloc(1,sizes.seccomp_notif);
  if(!request) { kill(child,SIGKILL); waitpid(child,NULL,0); close(listener); return 125; }
  int status=0;
  for(;;) {
    if(waitpid(child,&status,WNOHANG)==child) break;
    struct pollfd input={.fd=listener,.events=POLLIN}; if(poll(&input,1,100)<=0) continue;
    memset(request,0,sizes.seccomp_notif);
    if(ioctl(listener,SECCOMP_IOCTL_NOTIF_RECV,request)) { if(errno==EINTR||errno==ENOENT) continue; kill(child,SIGKILL); waitpid(child,&status,0); break; }
    int error=EPERM; int64_t value=0;
    if(valid(listener,request->id)) {
      if(request->data.nr==SYS_connect) error=connect_pinned(listener,request,pinned,allowed);
      else if(request->data.nr==SYS_sendmsg) error=send_connected(listener,request,&value);
    }
    if(error==EPERM) dprintf(STDERR_FILENO,"{\"kind\":\"native-offline-socket-denial\",\"head\":\"%s\",\"success\":false,\"reason\":\"native socket operation denied\"}\n",head);
    struct seccomp_notif_resp response={.id=request->id,.error=-error,.val=value,.flags=0};
    /* flags=0: SECCOMP_USER_NOTIF_FLAG_CONTINUE would permit a memory race. */
    (void)ioctl(listener,SECCOMP_IOCTL_NOTIF_SEND,&response);
  }
  free(cookies);free(request); close(listener); child_pid=0;
  return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
}
int main(int argc,char **argv) {
  int probe=argc==3 && !strcmp(argv[1],"--probe");
  const char *head=probe?argv[2]:(argc>2?argv[2]:"");
  if(strlen(head)!=40 || strspn(head,"0123456789abcdef")!=40) return 125;
  char directory[]="/tmp/odysseus-connect-policy-XXXXXX",source[108],other[108];
  int server=-1; const char *allowed=NULL; int pinned=-1;
  if(probe) {
    if(!mkdtemp(directory)) return 125;
    snprintf(source,sizeof(source),"%s/relay.sock",directory); snprintf(other,sizeof(other),"%s/foreign.sock",directory);
    struct sockaddr_un address={.sun_family=AF_UNIX}; strcpy(address.sun_path,source);
    server=socket(AF_UNIX,SOCK_STREAM,0); if(server<0||bind(server,(struct sockaddr *)&address,sizeof(address))||listen(server,16)) return 125;
    pinned=open(source,O_PATH|O_CLOEXEC); allowed=source;
  } else {
    if(argc<13 || strcmp(argv[1],"--head") || strcmp(argv[3],"--socket") || strcmp(argv[5],"--device")
        || strcmp(argv[7],"--inode") || strcmp(argv[9],"--allowed") || strcmp(argv[11],"--")) return 125;
    pinned=open(argv[4],O_PATH|O_CLOEXEC); allowed=argv[10]; struct stat info;
    if(pinned<0||fstat(pinned,&info)||!S_ISSOCK(info.st_mode)||info.st_dev!=strtoull(argv[6],NULL,10)||info.st_ino!=strtoull(argv[8],NULL,10)) return 125;
  }
  if(pinned<0 || strlen(allowed)>=108) return 125;
  int result=run(pinned,allowed,head,probe?NULL:argv+12,probe,other); close(pinned);
  if(probe) { close(server); unlink(source); rmdir(directory); if(result==0) puts("NATIVE_SOCKET_POLICY_HELD"); }
  return result;
}
