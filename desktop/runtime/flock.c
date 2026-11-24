#include <errno.h>
#include <sys/file.h>

/* Node passes the journal's open file description to the child as fd 3.
 * Once acquired, this lock lives until Node closes its descriptor. */
int main(void) {
    if (flock(3, LOCK_EX | LOCK_NB) == 0) return 0;
    return (errno == EAGAIN || errno == EWOULDBLOCK) ? 75 : 1;
}
