/* Test-only privileged trampoline, installed by an isolated qualification fixture.
 * This is deliberately not a production helper or a supported installation.
 * The fixed script and interpreter must be root-owned and not group/world writable.
 */
#define _GNU_SOURCE
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <signal.h>

#define SCRIPT "/usr/local/lib/brain-identity-fixture/helper.py"
#define PYTHON "/usr/bin/python3"

static int trusted(const char *path) {
  struct stat info;
  return stat(path, &info) == 0 && S_ISREG(info.st_mode) &&
    info.st_uid == 0 && !(info.st_mode & 0022);
}

int main(int argc, char **argv) {
  if (getuid() != 21001 || geteuid() != 0 || argc != 4 ||
      strcmp(argv[1], "--brain-worker-identity-v1") ||
      !trusted(SCRIPT) || !trusted(PYTHON)) {
    fputs("identity fixture helper refused bootstrap\n", stderr);
    return 125;
  }
  pid_t parent = getppid();
  if (clearenv() || setresgid(0, 0, 0) || setresuid(0, 0, 0) ||
      prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) return 125;
  char *command[] = {PYTHON, "-I", "-S", SCRIPT, argv[2], argv[3], NULL};
  execv(PYTHON, command);
  return 125;
}
