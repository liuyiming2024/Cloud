#!/usr/bin/env bash
# 把回执写回页面仓库的 status/ 目录，页面轮询它就知道这趟搬完没有。
# 无论前面的步骤成败，这一步都要跑——页面在等这个结果，
# 拿不到回执它只能干等到超时，那比看到一条错误更糟。
set -uo pipefail

CFG_OK="$1"; CFG_MSG="$2"; OUTCOME="$3"; WORK_MSG="$4"
ST="/tmp/status.json"
PAPI="https://api.github.com/repos/${PAGE_OWNER}/${PAGE_REPO}"

if [ "$CFG_OK" != "true" ]; then
  jq -n --arg e "$CFG_MSG" '{ok:false,error:$e}' > "$ST"
elif [ ! -s "$ST" ]; then
  jq -n --arg e "${WORK_MSG:-搬运脚本没有留下回执，可能被中断}" '{ok:false,error:$e}' > "$ST"
fi

B64=$(base64 -w0 "$ST")
BODY=$(jq -n --arg c "$B64" --arg m "回执 ${JOB}" '{message:$m,content:$c}')

OUT=$(curl -sS -X PUT -H "Authorization: token ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "${PAPI}/contents/status/${JOB}.json" -d "$BODY")

if echo "$OUT" | jq -e '.content.commit' >/dev/null 2>&1; then
  echo "回执已写入 status/${JOB}.json"
else
  echo "::error::回执写入失败：$(echo "$OUT" | jq -r '.message // .')"
fi
exit 0
