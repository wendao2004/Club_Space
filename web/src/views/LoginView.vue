<!--
  登录 / 首次运行创建管理员。

  内网平台不应该开放注册 —— 所以只有两条路径：库里一个用户都没有时允许
  创建管理员（自举），之后一律需要管理员发放的邀请码。这个判断由后端
  /api/bootstrap 的 firstRun 给出，前端不自己猜。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { ApiError } from '@/api'
import { useAuth } from '@/stores/auth'
import { useUi } from '@/stores/ui'

const auth = useAuth()
const ui = useUi()

const mode = ref<'login' | 'register'>(auth.firstRun ? 'register' : 'login')

const username = ref('')
const displayName = ref('')
const password = ref('')
const password2 = ref('')
const inviteCode = ref('')
/** 两步登录的第二步：验证器上的 6 位数字。 */
const totpCode = ref('')
const busy = ref(false)
const error = ref('')
/** 字段级错误，避免只给一句笼统的"出错了" */
const fieldError = ref<{ username?: string; password?: string; invite?: string }>({})

const isFirstRun = computed(() => auth.firstRun)
const submitLabel = computed(() => {
  if (busy.value) return '处理中…'
  return mode.value === 'login' ? '登录' : isFirstRun.value ? '创建管理员并进入' : '使用邀请码注册'
})

function validate(): boolean {
  fieldError.value = {}
  if (mode.value === 'login') {
    if (!username.value.trim()) fieldError.value.username = '请输入用户名'
    if (!password.value) fieldError.value.password = '请输入口令'
  } else {
    const name = username.value.trim()
    if (name.length < 3 || name.length > 32) {
      fieldError.value.username = '用户名需 3-32 位'
    } else if (!/^[\w一-龥-]+$/u.test(name)) {
      fieldError.value.username = '只能用字母、数字、下划线、连字符或中文'
    }
    if (!displayName.value.trim()) {
      fieldError.value.username = fieldError.value.username ?? '请填写显示名称'
    }
    if (password.value.length < 8) {
      fieldError.value.password = '口令至少 8 位'
    } else if (password.value !== password2.value) {
      fieldError.value.password = '两次输入的口令不一致'
    }
    if (!isFirstRun.value && !inviteCode.value.trim()) {
      fieldError.value.invite = '需要邀请码，请向管理员索取'
    }
  }
  return Object.keys(fieldError.value).length === 0
}

async function submit(): Promise<void> {
  error.value = ''
  if (!validate()) return
  busy.value = true
  try {
    if (mode.value === 'login') {
      // 账号绑定了两步验证时，这一步只会拿到挑战令牌，还没真正登录。
      const done = await auth.login(username.value.trim(), password.value)
      if (!done) {
        totpCode.value = ''
        return
      }
      ui.notify('success', `欢迎回来，${auth.user?.displayName}`)
    } else {
      await auth.register({
        username: username.value.trim(),
        displayName: displayName.value.trim(),
        password: password.value,
        inviteCode: inviteCode.value.trim() || undefined,
      })
      ui.notify(
        'success',
        isFirstRun.value ? '管理员账号已创建' : '注册成功',
        isFirstRun.value ? '你就是这个平台的创建者，其他成员需要你发放邀请码才能加入。' : undefined,
      )
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '操作失败，请稍后重试'
  } finally {
    busy.value = false
  }
}

/** 两步登录的第二步。 */
async function submitTotp(): Promise<void> {
  error.value = ''
  if (!/^\d{6}$/.test(totpCode.value)) {
    error.value = '请输入验证器上显示的 6 位数字'
    return
  }
  busy.value = true
  try {
    await auth.submitTotp(totpCode.value)
    ui.notify('success', `欢迎回来，${auth.user?.displayName}`)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '验证失败，请重试'
    totpCode.value = ''
  } finally {
    busy.value = false
  }
}

function backToPassword(): void {
  auth.cancelTotp()
  password.value = ''
  totpCode.value = ''
  error.value = ''
}

function onTotpInput(event: Event): void {
  const input = event.target as HTMLInputElement
  totpCode.value = input.value.replace(/\D/g, '').slice(0, 6)
}

function switchMode(): void {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  error.value = ''
  fieldError.value = {}
}
</script>

<template>
  <div class="login">
    <div class="login__bg" />

    <form v-if="!auth.pendingTotp" class="login__card" @submit.prevent="submit">
      <header class="login__head">
        <div class="login__logo">
          <span v-for="i in 4" :key="i" />
        </div>
        <h1 class="login__title">{{ auth.siteName }}</h1>
        <p class="login__subtitle">
          {{
            mode === 'login'
              ? '登录后进入桌面'
              : isFirstRun
                ? '这是首次启动，先创建一个管理员账号'
                : '需要管理员发放的邀请码才能加入'
          }}
        </p>
      </header>

      <div class="wl-field">
        <label class="wl-label" for="login-username">用户名</label>
        <input
          id="login-username"
          v-model="username"
          class="wl-input"
          type="text"
          autocomplete="username"
          :placeholder="mode === 'login' ? '你的用户名' : '3-32 位，可用中文'"
        />
        <p v-if="fieldError.username" class="login__error">{{ fieldError.username }}</p>
      </div>

      <div v-if="mode === 'register'" class="wl-field">
        <label class="wl-label" for="login-display">显示名称</label>
        <input
          id="login-display"
          v-model="displayName"
          class="wl-input"
          type="text"
          placeholder="其他成员看到的名字"
        />
      </div>

      <div class="wl-field">
        <label class="wl-label" for="login-password">口令</label>
        <input
          id="login-password"
          v-model="password"
          class="wl-input"
          type="password"
          :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
          :placeholder="mode === 'login' ? '你的口令' : '至少 8 位'"
        />
        <p v-if="fieldError.password" class="login__error">{{ fieldError.password }}</p>
      </div>

      <div v-if="mode === 'register'" class="wl-field">
        <label class="wl-label" for="login-password2">确认口令</label>
        <input
          id="login-password2"
          v-model="password2"
          class="wl-input"
          type="password"
          autocomplete="new-password"
          placeholder="再输入一次"
        />
      </div>

      <div v-if="mode === 'register' && !isFirstRun" class="wl-field">
        <label class="wl-label" for="login-invite">邀请码</label>
        <input
          id="login-invite"
          v-model="inviteCode"
          class="wl-input"
          type="text"
          placeholder="向管理员索取"
        />
        <p v-if="fieldError.invite" class="login__error">{{ fieldError.invite }}</p>
      </div>

      <p v-if="error" class="login__alert">
        <Icon name="alert" :size="15" />
        <span>{{ error }}</span>
      </p>

      <button class="wl-btn wl-btn--primary login__submit" type="submit" :disabled="busy">
        <span v-if="busy" class="wl-spinner" />
        {{ submitLabel }}
      </button>

      <button v-if="!isFirstRun" class="login__switch" type="button" @click="switchMode">
        {{ mode === 'login' ? '有邀请码？去注册' : '已有账号？去登录' }}
      </button>

      <p class="login__note">
        这是部署在局域网内的社团平台，数据不出内网。
      </p>
    </form>

    <!--
      两步登录的第二步。
      口令正确但账号绑定了两步验证时走到这里 —— 服务端在这一步**还没有发会话**，
      所以这不是"再确认一次"，而是登录的必要环节。
    -->
    <form v-else class="login__card" @submit.prevent="submitTotp">
      <header class="login__head">
        <div class="login__logo">
          <span v-for="i in 4" :key="i" />
        </div>
        <h1 class="login__title">两步验证</h1>
        <p class="login__subtitle">
          {{ auth.pendingTotp?.displayName }}，请输入验证器上当前显示的 6 位数字
        </p>
      </header>

      <div class="wl-field">
        <label class="wl-label" for="login-totp">动态口令</label>
        <input
          id="login-totp"
          class="wl-input login__totp"
          type="text"
          inputmode="numeric"
          maxlength="6"
          autocomplete="one-time-code"
          placeholder="000000"
          :value="totpCode"
          @input="onTotpInput"
        />
      </div>

      <p v-if="error" class="login__alert">
        <Icon name="alert" :size="15" />
        <span>{{ error }}</span>
      </p>

      <button
        class="wl-btn wl-btn--primary login__submit"
        type="submit"
        :disabled="busy || totpCode.length !== 6"
      >
        <span v-if="busy" class="wl-spinner" />
        验证并登录
      </button>

      <button class="login__switch" type="button" @click="backToPassword">
        返回上一步
      </button>

      <p class="login__note">
        动态口令来自你绑定两步验证时使用的验证器 App。若手机时间不准，口令会对不上。
      </p>
    </form>
  </div>
</template>

<style scoped>
.login {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  overflow: auto;
}

/* 与桌面壁纸同源的"晨雾光斑"：登录页也是这套系统的一部分 */
.login__bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(1100px 620px at 78% 14%, rgba(116, 178, 235, 0.5), transparent 62%),
    radial-gradient(880px 520px at 12% 88%, rgba(150, 196, 240, 0.45), transparent 66%),
    radial-gradient(700px 420px at 55% 62%, rgba(255, 255, 255, 0.65), transparent 70%),
    linear-gradient(158deg, #eaf3fc 0%, #d9e9f8 48%, #eef5fb 100%);
}

.login__bg::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(1400px 900px at 50% -12%, rgba(255, 255, 255, 0.35), transparent 60%),
    radial-gradient(1200px 800px at 50% 118%, rgba(16, 40, 72, 0.06), transparent 62%);
}

[data-theme='dark'] .login__bg {
  background:
    radial-gradient(1100px 620px at 78% 12%, rgba(52, 104, 168, 0.55), transparent 62%),
    radial-gradient(880px 520px at 14% 86%, rgba(30, 64, 110, 0.5), transparent 66%),
    linear-gradient(158deg, #0d1420 0%, #101c2e 50%, #0c1119 100%);
}

[data-theme='dark'] .login__bg::after {
  background:
    radial-gradient(1400px 900px at 50% -12%, rgba(255, 255, 255, 0.06), transparent 60%),
    radial-gradient(1200px 800px at 50% 118%, rgba(0, 0, 0, 0.35), transparent 62%);
}

.login__card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 380px;
  padding: var(--space-6) var(--space-5) var(--space-5);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--surface-raised);
  backdrop-filter: blur(40px) saturate(1.6);
  box-shadow: var(--shadow-window);
}

.login__head {
  text-align: center;
  margin-bottom: var(--space-5);
}

.login__logo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  width: 36px;
  height: 36px;
  margin: 0 auto var(--space-4);
}

.login__logo span {
  background: var(--accent);
  border-radius: 2px;
}

.login__title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: var(--lh-tight);
}

.login__subtitle {
  margin: var(--space-1) 0 0;
  font-size: var(--fs-body);
  color: var(--text-secondary);
  line-height: 1.5;
}

.login__error {
  margin: var(--space-1) 0 0;
  font-size: var(--fs-caption);
  color: var(--danger);
}

.login__totp {
  font-family: var(--font-mono);
  font-size: 20px;
  letter-spacing: 0.4em;
  text-align: center;
  height: 44px;
}

.login__alert {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-body);
  line-height: 1.45;
}

.login__submit {
  width: 100%;
  height: 38px;
  margin-top: var(--space-4);
  font-size: var(--fs-subtitle);
}

.login__switch {
  display: block;
  width: 100%;
  margin-top: var(--space-3);
  font-size: var(--fs-body);
  color: var(--accent);
  text-align: center;
}

.login__switch:hover {
  text-decoration: underline;
}

.login__note {
  margin: var(--space-4) 0 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--line-hair);
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  text-align: center;
  line-height: 1.5;
}
</style>
