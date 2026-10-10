# Evaluation cases

`cases/<issue>-<slug>.json` holds the authored Odysseus cases of an open
[#838](https://github.com/schlessera/brain-kit/issues/838) candidate: each
case's id, split, inputs and expected labels, exported once from the retired
spike harness named in its `source` field. The files carry data only, with no
harness, freeze or receipt; a candidate's lean harness reads them and adds the
cases it is missing.
