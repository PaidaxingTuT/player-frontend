# EchoMusic 插件 SQLite API

本文档面向 EchoMusic 插件开发者，说明宿主提供的 `ctx.sqlite` 能力，包括接入方式、接口用法、返回结构、限制、注意事项和常见坑。

文档内容以当前仓库实现为准，主要对应这些位置：

- `src/renderer/plugins/runtime.ts`
- `src/plugin-window/main.ts`
- `src/shared/plugins.ts`
- `src/main/pluginSqlite.ts`
- `src/main/plugins.ts`
- `native/echo-storage/src/lib.rs`

## 适用范围

`ctx.sqlite` 是按插件隔离的本地 SQLite 能力。

- 主插件运行时可用
- 插件浮窗运行时可用
- 需要在 `manifest.json` 里显式声明 `capabilities.sqlite: true`
- 数据库文件按插件隔离，不允许跨插件复用

数据库文件会落在宿主用户数据目录下：

```text
<userData>/plugin-sqlite/<pluginId>/<databaseName>.sqlite
```

这条路径由宿主决定，插件侧不能自定义。

最小声明示例：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "main": "index.js",
  "capabilities": {
    "sqlite": true
  }
}
```

## 快速开始

```js
export async function activate(ctx) {
  const db = await ctx.sqlite.open({
    migrations: [
      {
        version: 1,
        sql: [
          `CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            extra_json TEXT NOT NULL DEFAULT '{}',
            done INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
          )`,
          'CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at DESC)',
        ],
      },
    ],
  })

  if (!db.ok) {
    ctx.toast.danger(`数据库打开失败: ${db.error}`)
    return
  }

  const insertResult = await db.run(
    'INSERT INTO todos (title, extra_json, done, created_at) VALUES (?, ?, ?, ?)',
    ['写文档', JSON.stringify({ from: 'plugin' }), false, Date.now()],
  )
  if (!insertResult.ok) {
    ctx.toast.danger(`写入失败: ${insertResult.error}`)
    return
  }

  const rowResult = await db.get('SELECT * FROM todos WHERE id = ?', [insertResult.lastInsertRowid])
  if (rowResult.ok) {
    console.log('单行结果', rowResult.row)
  }

  const listResult = await db.all(
    'SELECT * FROM todos ORDER BY created_at DESC LIMIT ?',
    [50],
  )
  if (listResult.ok) {
    console.log('列表结果', listResult.rows, listResult.truncated)
  }

  await db.close()
}
```

## API 总览

插件侧公开入口有 3 个：

- `ctx.sqlite.open(options?)`
- `ctx.sqlite.listDatabases()`
- `ctx.sqlite.deleteDatabase(name?)`

其中 `open()` 成功后会返回一个数据库句柄对象，句柄上再提供这些方法：

- `db.exec(sql)`
- `db.run(sql, params?)`
- `db.all(sql, params?, options?)`
- `db.get(sql, params?)`
- `db.transaction(statements)`
- `db.close()`

## 打开数据库

### `ctx.sqlite.open(options?)`

用于打开或创建数据库，并返回一个绑定当前数据库名的操作句柄。

参数：

```ts
interface PluginSqliteOpenOptions {
  name?: string
  migrations?: Array<{
    version: number
    sql: string | string[]
  }>
  readOnly?: boolean
  busyTimeoutMs?: number
}
```

插件侧成功返回值实际形态：

```ts
type PluginSqliteDatabaseHandle =
  | {
      ok: true
      pluginId: string
      databaseId: string
      name: string
      version: number
      exec(sql: string): Promise<PluginSqliteExecResult>
      run(sql: string, params?: PluginSqliteParams): Promise<PluginSqliteRunResult>
      all(
        sql: string,
        params?: PluginSqliteParams,
        options?: PluginSqliteQueryOptions,
      ): Promise<PluginSqliteQueryResult>
      get(
        sql: string,
        params?: PluginSqliteParams,
      ): Promise<{ ok: true; row: PluginSqliteRow | null } | { ok: false; error: string }>
      transaction(statements: PluginSqliteStatement[]): Promise<PluginSqliteExecResult>
      close(): Promise<PluginSqliteCloseResult>
    }
  | {
      ok: false
      error: string
    }
```

行为说明：

- `name` 默认是 `main`
- `readOnly !== true` 时，不存在的数据库会自动创建
- `readOnly === true` 时使用只读方式打开，数据库文件不存在会失败
- `migrations` 只会在非只读打开时执行
- 返回的 `version` 是最终 `PRAGMA user_version` 的值

数据库名规则：

- 最大 64 个字符
- 只能包含字母、数字、点、下划线、短横线
- 必须以字母或数字开头
- 默认名是 `main`

示例：

```js
const db = await ctx.sqlite.open({
  name: 'cache',
  busyTimeoutMs: 5000,
})
```

### 宿主默认连接配置

宿主在打开连接后会自动设置一些 SQLite 选项。

读写打开时：

- `PRAGMA journal_mode = WAL`
- `PRAGMA foreign_keys = ON`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA temp_store = MEMORY`

只读打开时：

- `PRAGMA foreign_keys = ON`
- `PRAGMA temp_store = MEMORY`

这意味着：

- 正常读写库默认会生成 `-wal` / `-shm` 文件
- 外键约束默认启用
- 你一般不需要自己重复设置这些常见 PRAGMA

## 数据库句柄方法

### `db.exec(sql)`

适合执行不带参数的批量 SQL，底层使用 `execute_batch`。

典型场景：

- 一次执行多条 DDL
- 执行不需要参数绑定的初始化 SQL

返回值：

```ts
type PluginSqliteExecResult =
  | { ok: true }
  | { ok: false; error: string }
```

示例：

```js
await db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);
`)
```

注意：

- 不支持参数绑定
- 更适合 schema、批量 DDL、显式无参数语句
- 不是每种 SQL 都适合 `exec`，查询语句请用 `all` 或 `get`

### `db.run(sql, params?)`

适合执行单条写入类语句，底层会返回影响行数和最后插入行 ID。

参数：

```ts
type PluginSqliteParams = Array<string | number | boolean | null>
```

返回值：

```ts
type PluginSqliteRunResult =
  | {
      ok: true
      changes: number
      lastInsertRowid: number
    }
  | {
      ok: false
      error: string
    }
```

示例：

```js
const result = await db.run(
  'UPDATE settings SET value_json = ? WHERE key = ?',
  [JSON.stringify({ theme: 'dark' }), 'ui'],
)

if (result.ok) {
  console.log(result.changes, result.lastInsertRowid)
}
```

注意：

- 只适合不返回结果集的单条语句
- 参数必须是数组
- 数组元素只允许 `string`、`number`、`boolean`、`null`

### `db.all(sql, params?, options?)`

执行查询并返回多行结果。

参数：

```ts
interface PluginSqliteQueryOptions {
  limit?: number
}
```

返回值：

```ts
type PluginSqliteQueryResult =
  | {
      ok: true
      rows: PluginSqliteRow[]
      rowCount: number
      truncated: boolean
    }
  | {
      ok: false
      error: string
    }
```

示例：

```js
const result = await db.all(
  'SELECT id, title, done, created_at FROM todos WHERE done = ? ORDER BY created_at DESC',
  [0],
  { limit: 200 },
)
```

返回字段说明：

- `rows`：当前返回的行数组
- `rowCount`：当前返回的行数
- `truncated`：是否因为 `limit` 被截断

重要说明：

- `rowCount` 不是总匹配行数
- 当 `truncated === true` 时，`rowCount` 只表示本次实际返回了多少行
- 如果你需要分页，请自己在 SQL 里写 `LIMIT/OFFSET`

### `db.get(sql, params?)`

查询单行数据。插件侧做了一层包装，成功时只返回 `row`，不是完整 `rows` 数组。

返回值：

```ts
type PluginSqliteGetResult =
  | {
      ok: true
      row: PluginSqliteRow | null
    }
  | {
      ok: false
      error: string
    }
```

示例：

```js
const result = await db.get('SELECT * FROM settings WHERE key = ?', ['ui'])

if (result.ok) {
  console.log(result.row)
}
```

注意：

- 本质上等价于 `all(..., { limit: 1 })` 再取第一行
- 没有查到时返回 `row: null`

### `db.transaction(statements)`

按顺序执行多条写入语句，全部成功才提交，任意一条失败则整个事务失败。

参数：

```ts
interface PluginSqliteStatement {
  sql: string
  params?: PluginSqliteParams
}
```

返回值：

```ts
type PluginSqliteExecResult =
  | { ok: true }
  | { ok: false; error: string }
```

示例：

```js
const result = await db.transaction([
  {
    sql: 'INSERT INTO todos (title, extra_json, done, created_at) VALUES (?, ?, ?, ?)',
    params: ['A', '{}', false, Date.now()],
  },
  {
    sql: 'INSERT INTO todos (title, extra_json, done, created_at) VALUES (?, ?, ?, ?)',
    params: ['B', '{}', true, Date.now()],
  },
])
```

注意：

- 最多 500 条语句
- 每个元素只能是一条语句，不要把多条 SQL 塞进一个 `sql`
- 事务里的参数限制与 `run` 一样

### `db.close()`

关闭当前数据库句柄对应的数据库。

返回值：

```ts
type PluginSqliteCloseResult =
  | {
      ok: true
      closed: boolean
    }
  | {
      ok: false
      error: string
    }
```

`closed` 含义：

- `true`：这次确实关掉了一个已打开数据库
- `false`：当前数据库本来就没开，或者已被别处先关闭

## 列库与删库

### `ctx.sqlite.listDatabases()`

列出当前插件名下所有数据库文件。

返回值：

```ts
type PluginSqliteListResult =
  | {
      ok: true
      databases: Array<{
        name: string
        size: number
        modifiedAt: number
      }>
    }
  | {
      ok: false
      error: string
    }
```

示例：

```js
const result = await ctx.sqlite.listDatabases()
```

### `ctx.sqlite.deleteDatabase(name?)`

删除当前插件名下指定数据库。

返回值：

```ts
type PluginSqliteDeleteResult =
  | {
      ok: true
      deleted: boolean
    }
  | {
      ok: false
      error: string
    }
```

行为说明：

- 默认删除 `main`
- 删除前会先尝试关闭同名数据库
- 会同时删除 `.sqlite`、`-wal`、`-shm`

示例：

```js
await ctx.sqlite.deleteDatabase('cache')
```

## 迁移用法

推荐只在 `open()` 时通过 `migrations` 做 schema 管理。

示例：

```js
const db = await ctx.sqlite.open({
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE IF NOT EXISTS articles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          body TEXT NOT NULL
        )
      `,
    },
    {
      version: 2,
      sql: [
        'ALTER TABLE articles ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0',
        'CREATE INDEX IF NOT EXISTS idx_articles_created_at ON articles(created_at DESC)',
      ],
    },
  ],
})
```

迁移规则：

- `version` 必须是 `1` 到 `999999` 的整数
- 宿主会按 `version` 升序排序后执行
- 已经小于等于当前 `user_version` 的迁移会被跳过
- 每个迁移版本都会自动包一层事务，并在成功后写入 `PRAGMA user_version = version`
- 任意迁移失败会回滚当前迁移版本

迁移注意事项：

- 不要在迁移 SQL 里自己写 `BEGIN`、`COMMIT`、`ROLLBACK`
- 不要把需要参数绑定的语句写进迁移，迁移不支持参数数组
- 只读打开时不会执行迁移，只会读取当前版本号

## 数据类型与返回值

### 参数支持

写入参数只支持：

- `string`
- `number`
- `boolean`
- `null`

不支持：

- `undefined`
- `Date`
- `bigint`
- `Array`
- `Object`
- `Uint8Array`
- 其他任意复杂结构

复杂结构请自行序列化，例如：

```js
await db.run(
  'INSERT INTO settings (key, value_json) VALUES (?, ?)',
  ['ui', JSON.stringify({ theme: 'dark', compact: true })],
)
```

### 查询结果支持

查询结果中的列值会被转换为：

- `NULL` -> `null`
- `INTEGER` -> `number`
- `REAL` -> `number`
- `TEXT` -> `string`
- `BLOB` -> `{ type: 'hex', data: string }`

`PluginSqliteRow` 定义：

```ts
type PluginSqliteValue = string | number | boolean | null | { type: 'hex'; data: string }
type PluginSqliteRow = Record<string, PluginSqliteValue>
```

注意这里有一个实现细节：

- 类型定义里允许 `boolean`
- 但原生层实际把布尔参数写成 `0` / `1`
- 查询出来时也会以整数 `0` / `1` 返回，不会自动还原成 `true` / `false`

也就是说，这段代码：

```js
await db.run('INSERT INTO todos (done) VALUES (?)', [true])
const result = await db.get('SELECT done FROM todos ORDER BY id DESC LIMIT 1')
```

最终更可能拿到：

```js
result.row.done === 1
```

不要依赖它返回布尔值。

### BLOB 返回

如果查询结果里有 BLOB，宿主会转成十六进制对象：

```js
{
  type: 'hex',
  data: '89504e470d0a...'
}
```

这适合调试或做轻量存档，不适合存很大的二进制内容。

## 限制与边界

### SQL 限制

单条或整段 SQL 文本最大长度约 `256 KiB`。

以下语句会被宿主直接拦截：

- `ATTACH`
- `DETACH`
- `VACUUM INTO`
- `load_extension(...)`
- `PRAGMA database_list`

原因很直接：

- 禁止插件挂接外部数据库
- 禁止加载本地扩展
- 避免插件突破当前插件自己的数据库边界

### 查询限制

- `all()` 默认 `limit = 1000`
- `limit` 最小 `1`
- `limit` 最大 `5000`
- 查询结果序列化后的 JSON 最大约 `8 MiB`

超过限制时的表现：

- 行数超过限制：返回 `truncated: true`
- 结果 JSON 太大：直接失败，返回 `ok: false`

### 事务限制

- 一次事务最多 500 条语句
- 任意一条失败，整批失败

### 超时限制

`busyTimeoutMs` 的有效范围最终会被夹到 `100` 到 `30000` 毫秒之间。

实际规则：

- 未传、`0`、`NaN`：按 `3000ms`
- 小于 `100`：按 `100ms`
- 大于 `30000`：按 `30000ms`

## 生命周期与并发注意事项

这一部分非常重要。

### 1. 句柄不是独立连接

宿主内部真正用来标识数据库的是：

```text
databaseId = `${pluginId}:${databaseName}`
```

这意味着：

- 同一插件里，只要数据库名一样，底层就是同一个逻辑数据库标识
- `db` 句柄本质上只是“拿着一个 `databaseId` 去调宿主”
- 它不是私有连接对象

### 2. 重复打开同名数据库会影响旧句柄

如果你已经打开了：

```js
const db1 = await ctx.sqlite.open({ name: 'main' })
```

后面又打开一次：

```js
const db2 = await ctx.sqlite.open({ name: 'main', readOnly: true })
```

那么新的打开动作会替换底层同名连接。老句柄 `db1` 后续继续调用时，也是在使用新的同名连接配置。

实际后果：

- 旧句柄不会自动失效
- 但它背后的连接配置可能已经被新打开动作改掉
- `readOnly`、`busyTimeoutMs`、连接模式会以最后一次打开为准

推荐做法：

- 每个数据库名只维护一个单例句柄
- 不要在多个模块里随手重复 `open('main')`

### 3. 不同运行时会互相影响

主插件、插件浮窗、miniPlayer、桌面歌词如果都属于同一个插件，并且都打开同名数据库，会共享同一个 `databaseId` 语义。

实际后果：

- 任一运行时 `close()`，其他运行时的同名句柄也会受影响
- 任一运行时重新 `open()` 同名库，其他运行时的同名句柄也会被切换到底层新连接
- 运行时销毁时，宿主会自动关闭它记录过的数据库；如果名字撞上，也可能把别处正在用的同名库关掉

推荐做法：

- 同一插件的多个运行时尽量避免同时操作同名库
- 如果必须共享数据库，自己做统一的打开策略
- 最稳妥的是按场景拆库，例如 `main`、`cache`、`window-cache`

### 4. 句柄可能被外部关闭

即使当前代码没有调用 `db.close()`，下面这些情况也可能让后续操作报错：

- 同插件其他运行时关闭了同名数据库
- 调用了 `ctx.sqlite.deleteDatabase(name)`
- 插件被停用
- 插件进入安全模式
- 应用退出

典型报错会是：

```text
Plugin SQLite database is not open
```

推荐做法：

- 长生命周期模块里，遇到这个错误要允许重新 `open()`
- 不要把 `db` 句柄当成永远有效

## 常见错误与处理建议

### `插件未声明 SQLite 能力`

原因：

- `manifest.json` 没写 `capabilities.sqlite: true`

处理：

- 补上声明

### `插件安全模式已开启`

原因：

- 宿主启用了插件安全模式

处理：

- 这是宿主级保护，插件侧无法绕过

### `SQLite 数据库不属于当前插件`

原因：

- 使用了其他插件的 `databaseId`
- 自己拼了非法 `databaseId`

处理：

- 把 `databaseId` 当作宿主返回的 opaque 值使用
- 不要手写或跨插件保存复用

### `SQLite SQL 包含不允许的语句`

原因：

- 命中了被宿主封禁的 SQL 关键字

处理：

- 改成当前插件自己单库内可执行的方案

### `SQLite 参数必须是数组`

原因：

- `run`、`all`、`get`、`transaction` 传参格式不对

处理：

- 统一传数组，即使只有一个参数也要写成 `['value']`

### `SQLite 参数仅支持 string、number、boolean 和 null`

原因：

- 直接传了对象、数组、二进制、`undefined`

处理：

- 自行做字符串化或拆字段

### `SQLite 查询结果过大`

原因：

- 返回数据太多，序列化后超过上限

处理：

- 改成分页查询
- 减少列数
- 避免把大文本或大 BLOB 整批读出来

## 什么时候用 `ctx.storage`，什么时候用 `ctx.sqlite`

优先用 `ctx.storage` 的场景：

- 少量偏好设置
- 一两个 JSON 对象
- 不需要 SQL 查询
- 不需要多表关系

优先用 `ctx.sqlite` 的场景：

- 需要索引、筛选、排序、分页
- 需要多表关联
- 需要事务
- 数据量明显大于普通配置项
- 需要结构化缓存

简单经验：

- 配置类数据先考虑 `ctx.storage`
- 结构化业务数据再上 `ctx.sqlite`

## 推荐实践

- 插件启动时集中 `open()`，停用时集中 `close()`
- 每个数据库名只维护一个单例句柄
- schema 变更统一走 `migrations`
- 对复杂参数和复杂列统一手动 `JSON.stringify` / `JSON.parse`
- 查询时总是显式写 `LIMIT`
- 对缓存库和正式数据分库
- 预期到 `db` 句柄可能被别处关闭，失败时允许重开

## 不推荐实践

- 在多个模块、多个运行时里重复打开同名数据库
- 把布尔值读回后当成真正布尔使用
- 把大二进制长期塞进 SQLite 再整批读出
- 迁移里自己写事务控制语句
- 依赖 `rowCount` 作为“总命中数”

## 参考速查

```js
const db = await ctx.sqlite.open({
  name: 'main',
  migrations: [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)' }],
})

if (!db.ok) throw new Error(db.error)

await db.run(
  'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ['token', 'abc'],
)

const one = await db.get('SELECT value FROM kv WHERE key = ?', ['token'])
const many = await db.all('SELECT key, value FROM kv ORDER BY key LIMIT ?', [100])

await db.transaction([
  { sql: 'DELETE FROM kv WHERE key = ?', params: ['token'] },
  { sql: 'INSERT INTO kv (key, value) VALUES (?, ?)', params: ['token', 'new-value'] },
])

await db.close()
```
