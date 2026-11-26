import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'usage' | 'personal' | 'sync' | 'data' | 'drift' | 'about'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 新手引导是否已完成（与 Onboarding 里的 KEY 保持一致） */
export const ONBOARDED_KEY = 'chat-desktop:onboarded'

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  // 新手引导还没走完：不要抢在引导前面弹设置，等引导结束时由 Onboarding 自己打开
  if (localStorage.getItem(ONBOARDED_KEY) !== '1') {
    return false
  }
  openSettings('data')
  return false
}
