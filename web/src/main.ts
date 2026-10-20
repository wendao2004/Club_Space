import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { setUnauthorizedHandler } from './api'
import { useAuth } from './stores/auth'
import './styles/tokens.css'
import './styles/base.css'

const pinia = createPinia()
createApp(App).use(pinia).mount('#app')

// 任何接口返回 401 都把界面切回登录页（原因见 api.ts 里 setUnauthorizedHandler 上方那段）。
// 必须在 mount 之后注册：handleUnauthorized 会去断开 realtime 连接，
// 而 pinia 里还没建这个 store 时调它会顺手把一份空状态建出来。
setUnauthorizedHandler(() => useAuth(pinia).handleUnauthorized())
