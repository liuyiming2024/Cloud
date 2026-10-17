-- 给 Cloud 用：按 uid 取账号注册时间
--
-- 为什么需要它：
--   之前 identity.js 直接用 anon key 查 users 表（rest/v1/users?select=created_at）。
--   那是拿公开凭据直连数据表，安全性完全压在 RLS 上 —— RLS 配错一次，
--   整张 users 表就可读。改成走函数层后，由函数自己决定给什么，
--   不依赖表的 policy 配得对不对。
--
-- 不建也能用：拿不到注册时间就少一个派生因子，口令照样算得出来。
-- 建了更好。

create or replace function user_created_at(p_uid uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  -- 只允许查自己。别人问就给 null，不报错 —— 报错本身也是一种信息泄露。
  select created_at from users
  where id = p_uid and p_uid = cur_user();
$$;

-- 只给已登录的人调用，匿名不给
revoke all on function user_created_at(uuid) from public, anon;
grant execute on function user_created_at(uuid) to authenticated;
