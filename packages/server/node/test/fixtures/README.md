## Go journal

The files in `go-journal/` come from a closed Go journal.Store for the test document `inspect-example`. Its lineage is `00112233445566778899aabbccddeeff`, its epoch is 7 and its first generation contains three Yjs operations. Go published the checkpoint at sequence 1. Applying that checkpoint and operations 2 and 3 to a fresh Y.Doc yields `start-1-2-3` in the shared text named `text`. The fixture includes the four files needed to inspect the active generation.
