#!/usr/bin/env bash
# Cloud Drive · 搬运脚本（在 Actions 里跑）
#
# 密文在「公开暂存区」与「私有存储库」之间搬一趟。
# 本文件里不出现任何私有库名与令牌——它们只通过环境变量注入。
set -uo pipefail

PAPI="https://api.github.com/repos/${PAGE_OWNER}/${PAGE_REPO}"
DAPI="https://api.github.com/repos/${DRIVE_REPO}"
ST="/tmp/status.json"

# --- 工具 ------------------------------------------------------------------
page() { # 操作页面所在的公开仓库，用 workflow 自带的 GITHUB_TOKEN
  curl -sS -H "Authorization: token ${GITHUB_TOKEN}" \
       -H "Accept: application/vnd.github+json" \
       -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}
drive() { # 操作私有存储库，用高权限 PAT
  curl -sS -H "Authorization: token ${DRIVE_PAT}" \
       -H "Accept: application/vnd.github+json" \
       -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}
page_raw() { # 拿原文，不读 base64
  curl -sS -L -H "Authorization: token ${GITHUB_TOKEN}" \
       -H "Accept: application/vnd.github.raw" "$@"
}
drive_raw() {
  curl -sS -L -H "Authorization: token ${DRIVE_PAT}" \
       -H "Accept: application/vnd.github.raw" "$@"
}
jqr() { jq -r "$@"; }

fail() { # 写失败回执并正常退出——失败要让页面看到原因，而不是让 job 红叉了事
  echo "::error::$1"
  jq -n --arg e "$1" '{ok:false,error:$e}' > "$ST"
  exit 0
}
okjson() {
  jq -n --argjson extra "$1" '({ok:true}+$extra)' > "$ST"
}
sha_of() { # 读某仓库某路径的 sha，不存在返回空
  local api="$1" path="$2"
  local r
  r=$(curl -sS -H "Authorization: token ${3}" -H "Accept: application/vnd.github+json" \
        "${api}/contents/${path}?ref=main")
  echo "$r" | jq -r 'if type=="object" and .sha then .sha else "" end'
}
put_file() { # put_file <api> <token> <path> <本地文件> <message>
  local api="$1" tok="$2" path="$3" file="$4" msg="$5"
  local b64 old
  b64=$(base64 -w0 "$file")
  old=$(curl -sS -H "Authorization: token ${tok}" -H "Accept: application/vnd.github+json" \
        "${api}/contents/${path}?ref=main" | jq -r 'if type=="object" and .sha then .sha else "" end')
  local body
  if [ -n "$old" ]; then
    body=$(jq -n --arg m "$msg" --arg c "$b64" --arg s "$old" '{message:$m,content:$c,sha:$s}')
  else
    body=$(jq -n --arg m "$msg" --arg c "$b64" '{message:$m,content:$c}')
  fi
  local out
  out=$(curl -sS -X PUT -H "Authorization: token ${tok}" \
        -H "Accept: application/vnd.github+json" "${api}/contents/${path}" -d "$body")
  if echo "$out" | jq -e '.content and .commit' >/dev/null 2>&1; then return 0; fi
  echo "::error::写文件失败 ${path}: $(echo "$out" | jq -r '.message // .')"
  return 1
}
del_file() { # del_file <api> <token> <path> <message>
  local api="$1" tok="$2" path="$3" msg="$4"
  local old
  old=$(curl -sS -H "Authorization: token ${tok}" -H "Accept: application/vnd.github+json" \
        "${api}/contents/${path}?ref=main" | jq -r 'if type=="object" and .sha then .sha else "" end')
  [ -z "$old" ] && return 0
  curl -sS -X DELETE -H "Authorization: token ${tok}" -H "Accept: application/vnd.github+json" \
    "${api}/contents/${path}" -d "$(jq -n --arg m "$msg" --arg s "$old" '{message:$m,sha:$s}')" >/dev/null
  return 0
}
mkdir -p /tmp/drive
echo "{}" > "$ST"

# 存储库名：Secret 里没配就用默认值。真正的机密是令牌，不是库名——
# 私有库就算被人知道名字，没有令牌一样打不开。
[ -z "${DRIVE_REPO:-}" ] && DRIVE_REPO="liuyiming2024/Cloud_file"

# --- 解析 meta -------------------------------------------------------------
NAME=""; SIZE=0
if [ -n "${META}" ]; then
  M=$(echo "${META}" | base64 -d 2>/dev/null || echo '{}')
  NAME=$(echo "$M" | jq -r '.name // ""')
  SIZE=$(echo "$M" | jq -r '.size // 0')
fi

# --- 索引读写（索引在私有库；文件名是密文，放哪都不泄密） -----------------
read_index() {
  local r
  r=$(drive_raw "${DAPI}/contents/index.json?ref=main" 2>/dev/null)
  if [ -z "$r" ] || ! echo "$r" | jq -e . >/dev/null 2>&1; then
    echo '{"v":1,"files":[]}'
  else
    echo "$r" | jq -c '.'
  fi
}
write_index() {
  local idx="$1"
  put_file "${DAPI}" "${DRIVE_PAT}" "index.json" <(echo "$idx") "更新索引 ${ID:-}" \
    || fail "索引写入私有库失败"
}

# --- Release 通道（大文件） ------------------------------------------------
ensure_release() { # 固定 tag，可重复运行；返回 release id
  local rid
  rid=$(drive "${DAPI}/releases/tags/latest" | jq -r '.id // empty')
  if [ -z "$rid" ]; then
    rid=$(drive -X POST "${DAPI}/releases" \
      -d "$(jq -n '{tag_name:"latest",name:"drive",body:"Cloud Drive 大文件存储",prerelease:false}')" \
      | jq -r '.id // empty')
  fi
  echo "$rid"
}
release_asset_up() { # release_asset_up <release_id> <asset名> <文件>
  local rid="$1" an="$2" file="$3"
  local old
  old=$(drive "${DAPI}/releases/${rid}/assets" | jq -r --arg n "$an" '.[]|select(.name==$n)|.id' | head -1)
  [ -n "$old" ] && drive -X DELETE "${DAPI}/releases/assets/${old}" >/dev/null
  local out
  out=$(curl -sS -X POST -H "Authorization: token ${DRIVE_PAT}" \
        -H "Content-Type: application/octet-stream" \
        "https://uploads.github.com/repos/${DRIVE_REPO}/releases/${rid}/assets?name=${an}" \
        --data-binary @"$file")
  echo "$out" | jq -e '.id' >/dev/null 2>&1 || { echo "::error::Release 资产上传失败: $(echo "$out"|jq -r '.message//.')"; return 1; }
  return 0
}
release_asset_down() { # release_asset_down <asset名> <输出文件>
  local an="$1" out="$2"
  local aid
  aid=$(drive "${DAPI}/releases/tags/latest" | jq -r --arg n "$an" '.assets[]?|select(.name==$n)|.id' | head -1)
  if [ -z "$aid" ]; then
    aid=$(drive "${DAPI}/releases" | jq -r --arg n "$an" '.[].assets[]?|select(.name==$n)|.id' | head -1)
  fi
  [ -z "$aid" ] && return 1
  curl -sS -L -H "Authorization: token ${DRIVE_PAT}" -H "Accept: application/octet-stream" \
    "${DAPI}/releases/assets/${aid}" -o "$out"
  return 0
}

# --- 各操作 ----------------------------------------------------------------
case "$OP" in

  put)
    SRC="/tmp/drive/in.bin"
    page_raw "${PAPI}/contents/inbox/${JOB}.bin?ref=main" -o "$SRC" \
      || fail "读不到暂存文件 inbox/${JOB}.bin"
    CSIZE=$(stat -c%s "$SRC")
    [ "$CSIZE" -lt 32 ] && fail "暂存文件是空的或过小（${CSIZE} 字节），上传可能被中断"

    STORE="git"
    if [ "$CSIZE" -gt "${BIG}" ]; then
      STORE="release"
      RID=$(ensure_release)
      [ -z "$RID" ] && fail "无法准备大文件存储位"
      release_asset_up "$RID" "${ID}.bin" "$SRC" || fail "大文件写入存储失败"
    else
      put_file "${DAPI}" "${DRIVE_PAT}" "files/${ID}.bin" "$SRC" "存入 ${ID}" \
        || fail "写入存储失败"
    fi

    IDX=$(read_index)
    NEW=$(echo "$IDX" | jq -c --arg id "$ID" --arg n "$NAME" --argjson s "$SIZE" \
          --argjson c "$CSIZE" --arg st "$STORE" --arg t "$(date -u +%FT%TZ)" \
          '.files = ([.files[]? | select(.id != $id)] + [{id:$id,name:$n,size:$s,cipher:$c,store:$st,at:$t}])')
    write_index "$NEW"

    del_file "${PAPI}" "${GITHUB_TOKEN}" "inbox/${JOB}.bin" "清理暂存 ${JOB}"
    okjson "$(jq -n --arg id "$ID" --argjson c "$CSIZE" --arg st "$STORE" '{id:$id,cipher:$c,store:$st}')"
    ;;

  get)
    DST="/tmp/drive/out.bin"
    if ! drive_raw "${DAPI}/contents/files/${ID}.bin?ref=main" -o "$DST" 2>/dev/null \
       || [ ! -s "$DST" ]; then
      release_asset_down "${ID}.bin" "$DST" || fail "存储里没有这个文件：${ID}"
    fi
    CSIZE=$(stat -c%s "$DST")
    if [ "$CSIZE" -gt "${BIG}" ]; then
      # 大文件走页面仓库的公开 Release，页面可直接匿名下载直链
      PRID=$(page "${PAPI}/releases/tags/dl" | jq -r '.id // empty')
      if [ -z "$PRID" ]; then
        PRID=$(page -X POST "${PAPI}/releases" \
          -d "$(jq -n '{tag_name:"dl",name:"download",body:"临时下载位",prerelease:false}')" | jq -r '.id // empty')
      fi
      [ -z "$PRID" ] && fail "无法准备下载位"
      # 注意：这里不是函数内，不能用 local
      old_asset=$(page "${PAPI}/releases/${PRID}/assets" | jq -r --arg n "${ID}.bin" '.[]|select(.name==$n)|.id'|head -1)
      [ -n "$old_asset" ] && page -X DELETE "${PAPI}/releases/assets/${old_asset}" >/dev/null
      curl -sS -X POST -H "Authorization: token ${GITHUB_TOKEN}" \
        -H "Content-Type: application/octet-stream" \
        "https://uploads.github.com/repos/${PAGE_OWNER}/${PAGE_REPO}/releases/${PRID}/assets?name=${ID}.bin" \
        --data-binary @"$DST" >/dev/null
      okjson "$(jq -n --arg id "$ID" --argjson c "$CSIZE" --arg u "https://github.com/${PAGE_OWNER}/${PAGE_REPO}/releases/download/dl/${ID}.bin" '{id:$id,cipher:$c,channel:"release",url:$u}')"
    else
      put_file "${PAPI}" "${GITHUB_TOKEN}" "outbox/${JOB}.bin" "$DST" "取出 ${ID}" \
        || fail "回传暂存区失败"
      okjson "$(jq -n --arg id "$ID" --argjson c "$CSIZE" --arg p "outbox/${JOB}.bin" '{id:$id,cipher:$c,channel:"git",path:$p}')"
    fi
    ;;

  del)
    del_file "${DAPI}" "${DRIVE_PAT}" "files/${ID}.bin" "删除 ${ID}"
    RID=$(drive "${DAPI}/releases/tags/latest" | jq -r '.id // empty')
    if [ -n "$RID" ]; then
      AID=$(drive "${DAPI}/releases/${RID}/assets" | jq -r --arg n "${ID}.bin" '.[]|select(.name==$n)|.id'|head -1)
      [ -n "$AID" ] && drive -X DELETE "${DAPI}/releases/assets/${AID}" >/dev/null
    fi
    IDX=$(read_index)
    NEW=$(echo "$IDX" | jq -c --arg id "$ID" '.files = [.files[]? | select(.id != $id)]')
    write_index "$NEW"
    okjson "$(jq -n --arg id "$ID" '{id:$id}')"
    ;;

  list)
    IDX=$(read_index)
    put_file "${PAPI}" "${GITHUB_TOKEN}" "index.json" <(echo "$IDX") "同步目录" \
      || fail "目录同步回页面仓库失败"
    okjson "$(jq -n --argjson n "$(echo "$IDX" | jq '.files|length')" '{count:$n}')"
    ;;

  init)
    if [ -z "$(drive "${DAPI}/contents/index.json?ref=main" | jq -r '.sha // empty')" ]; then
      write_index '{"v":1,"files":[]}'
    fi
    okjson '{}'
    ;;

  *)
    fail "不认识的操作：${OP}"
    ;;
esac

exit 0
