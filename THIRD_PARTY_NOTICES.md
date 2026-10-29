# Third-party notices

The bundled `vendor/dsh-bili-whale` is a modified version of Bili Whale by
ALTERSSSS, under MIT; its license and notice are retained in that directory.
The bundled `vendor/tencent-dsh-qqbot-owner` is a modified version of Tencent's
DSH QQ Bot, under MIT; its license is retained in that directory. Tencent's
QQ Bot SDK and related dependencies are installed separately from npm.

The owner-only memory retrieval in `lib/memory-retrieval.mjs` adapts the
short-message retrieval gate from [Towzai/dsh-memory](https://github.com/Towzai/dsh-memory)
(revision `d0ba92e8ec14817f79f39b538521e3a904e1424c`) and the CJK bigram
fallback idea from [BayInl/dsh-memory](https://github.com/BayInl/dsh-memory)
(revision `44e50b062ff39b65112b91657103ed3226fa74ae`). Both are MIT-licensed.
License texts and BayInl's upstream notice are in `third-party-licenses/`.
This project does not install either plugin and does not use their default
project/global authorization, automatic transcript extraction, hosted models,
or session compaction.
