/* Compile-only check against the selected macOS SDK; this never runs. */
#include <stddef.h>
#include <libproc.h>
#include <sys/proc_info.h>

_Static_assert(PROC_PIDTBSDINFO == 3, "unexpected libproc flavor");
_Static_assert(sizeof(struct proc_bsdinfo) == 136, "unexpected proc_bsdinfo size");
_Static_assert(offsetof(struct proc_bsdinfo, pbi_status) == 4, "unexpected status offset");
_Static_assert(offsetof(struct proc_bsdinfo, pbi_pid) == 12, "unexpected PID offset");
_Static_assert(offsetof(struct proc_bsdinfo, pbi_ppid) == 16, "unexpected parent offset");
_Static_assert(offsetof(struct proc_bsdinfo, pbi_uid) == 20, "unexpected UID offset");
_Static_assert(offsetof(struct proc_bsdinfo, pbi_pgid) == 100, "unexpected group offset");
_Static_assert(offsetof(struct proc_bsdinfo, pbi_start_tvsec) == 120, "unexpected birth seconds offset");
_Static_assert(offsetof(struct proc_bsdinfo, pbi_start_tvusec) == 128, "unexpected birth microseconds offset");
