import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconLoadingOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importArchiveMerged,
  importSelectedSessions,
} from '../../services/chat/backup.js'
import { readArchiveIndex } from '../../services/chat/history/readIndex.js'
import { pickImportSessions } from './importSessionsDialog.js'
import { useIsMobile } from '../../app/viewport.js'
import { Modal } from '../base/Modal.js'
import { UsageSection } from './UsageSection.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {

  isChineseBrowser,
  setDriftSuppression,
  setFontSize,
  setLocale,
  setLocation,
  setMemories,
  setPreferences,
  setRemoteSizeWarning,
  setConfirmOverwrite,
  setShowCacheHit,
  setShowOutputSpeed,
  setThemePreference,
  setThinkingLanguage,
  setTtsVoice,
  promptLimitsOf,
  useSettings,
  type PromptItem,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import {
  pickPromptsForExport,
  pickTextFilesToImport,
  promptFileName,
} from './promptsExportDialog.js'
import { createId } from '../../utils/id.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  // 导入状态提到顶层：关闭弹窗时可以把进度和结果一起清掉，重开时不残留
  const historyImport = useHistoryImport()
  return open ? <SettingsContent historyImport={historyImport} /> : null
}

/** 侧边栏「坚果云账号配置」图标（云） */
const IconCloudOutline16 = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M4.6 11.6h6.9a2.7 2.7 0 0 0 .35-5.38A3.5 3.5 0 0 0 5.15 5.7 2.85 2.85 0 0 0 4.6 11.6Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
)

/** 侧边栏「关于」图标（信息） */
const IconInfoOutline16 = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.2" />
    <path d="M8 7v3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
  </svg>
)

/** 侧边栏「思维链漂移」图标（漂移曲线） */
const IconDriftOutline16 = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M2 11c2-4 4-6 6-6s4 2 6 6"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
    <path d="M2 11h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.35" />
  </svg>
)

/** 侧边栏「个人与记忆」图标（人形） */
const IconPersonOutline16 = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <circle cx="8" cy="5.4" r="2.7" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M2.8 13.2c0-2.6 2.3-4.2 5.2-4.2s5.2 1.6 5.2 4.2"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
)

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'usage', label: 'settingDialogAsideUsageOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'personal', label: 'settingDialogAsidePersonalOptionLabel', icon: <IconPersonOutline16 /> },
  {
    value: 'sync',
    label: 'settingDialogAsideSyncOptionLabel',
    icon: <IconCloudOutline16 />,
  },
  {
    value: 'drift',
    label: 'settingDialogAsideDriftOptionLabel',
    icon: <IconDriftOutline16 />,
  },
  {
    value: 'about',
    label: 'settingDialogAsideAboutOptionLabel',
    icon: <IconInfoOutline16 />,
  },
]

const SettingsContent = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 通用分组里的对话显示开关
  const showOutputSpeed = useSettings((state) => state.showOutputSpeed)
  const showCacheHit = useSettings((state) => state.showCacheHit)
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            historyImport.dismiss()
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, fontSize: 13 }}>
                {t(item.label)
                  .split('\n')
                  .map((line, index) => (
                    <span
                      key={index}
                      style={
                        index === 0
                          ? undefined
                          : {
                              fontSize: 11,
                              fontWeight: 400,
                              opacity: 0.65,
                            }
                      }
                    >
                      {line}
                    </span>
                  ))}
              </span>
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <ThinkingLanguageSetting />
              <FontSizeSetting />
              <ZoomSetting />
              <OnboardingSetting />
              <LocationSetting />
              <BooleanSetting
                label={t('settingsShowOutputSpeed')}
                description={t('settingsShowOutputSpeedDesc')}
                value={showOutputSpeed}
                onChange={setShowOutputSpeed}
              />
              <BooleanSetting
                label={t('settingsShowCacheHit')}
                description={t('settingsShowCacheHitDesc')}
                value={showCacheHit}
                onChange={setShowCacheHit}
              />
            </>
          ) : section === 'usage' ? (
            <UsageSection />
          ) : section === 'personal' ? (
            <PersonalMemorySection />
          ) : section === 'sync' ? (
            <SyncAccountSection />
          ) : section === 'drift' ? (
            <DriftSection />
          ) : section === 'about' ? (
            <AboutSection />
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 思考语言：默认只让思考走简体中文，也可让回答也走中文。 */
const ThinkingLanguageSetting = () => {
  const t = useTranslate()
  const thinkingLanguage = useSettings((state) => state.thinkingLanguage)
  return (
    <SettingCell
      label={t('settingsThinkingLanguage')}
      description={t('systemPromptCacheHint')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsThinkingLanguage')}
          value={thinkingLanguage}
          options={[
            { value: 'auto', label: t('settingsThinkingLanguageAuto') },
            { value: 'thinking', label: t('settingsThinkingLanguageThinking') },
            { value: 'all', label: t('settingsThinkingLanguageAll') },
          ]}
          onChange={(value) => setThinkingLanguage(value as 'auto' | 'thinking' | 'all')}
        />
      }
    />
  )
}

/** 对话正文字号：按像素给出常用档位，类似文字处理软件的字号列表。 */
const FONT_SIZE_OPTIONS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24]

const FontSizeSetting = () => {
  const t = useTranslate()
  const fontSize = useSettings((state) => state.fontSize)
  return (
    <SettingCell
      label={t('settingsFontSize')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsFontSize')}
          value={String(fontSize)}
          options={FONT_SIZE_OPTIONS.map((size) => ({ value: String(size), label: `${size}px` }))}
          onChange={(value) => setFontSize(Number(value))}
        />
      }
    />
  )
}

type SyncBridge = {
  getZoom?: () => Promise<number>
  setZoom?: (value: number) => Promise<number>
  getSyncAccount?: () => Promise<{ user: string; hasPass: boolean }>
  setSyncAccount?: (account: { user: string; pass: string }) => Promise<boolean>
}

const syncBridge = () => (window as unknown as { __syncBridge?: SyncBridge }).__syncBridge

const ZOOM_OPTIONS = ['0.8', '0.9', '1', '1.1', '1.25', '1.5']

const fieldStyle = {
  display: 'block',
  width: '100%',
  marginBottom: 8,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
  boxSizing: 'border-box',
} as const

/** 界面整体缩放，只影响本机窗口。 */
const ZoomSetting = () => {
  const t = useTranslate()
  const [zoom, setZoom] = useState(1)
  useEffect(() => {
    void syncBridge()?.getZoom?.().then((value) => {
      if (typeof value === 'number') setZoom(value)
    })
  }, [])
  return (
    <SettingCell
      label={t('settingsZoom')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsZoom')}
          value={String(zoom)}
          options={ZOOM_OPTIONS.map((value) => ({
            value,
            label: `${Math.round(Number(value) * 100)}%`,
          }))}
          onChange={(value) => {
            const next = Number(value)
            setZoom(next)
            void syncBridge()?.setZoom?.(next)
          }}
        />
      }
    />
  )
}

/** 坚果云账号：同步对话历史用，凭据由主进程加密保存。 */
const SyncAccountSetting = () => {
  const t = useTranslate()
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [hasPass, setHasPass] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void syncBridge()?.getSyncAccount?.().then((account) => {
      if (account) {
        setUser(account.user)
        setHasPass(account.hasPass)
      }
    })
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await syncBridge()?.setSyncAccount?.({ user, pass })
      setPass('')
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: '14px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('settingsSyncAccount')}</div>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--dsw-alias-label-secondary, #6b7280)',
          marginBottom: 10,
        }}
      >
        {t('settingsSyncAccountHint')}
      </div>
      <input
        value={user}
        onChange={(event) => setUser(event.target.value)}
        placeholder={t('settingsSyncEmail')}
        style={fieldStyle}
      />
      <input
        type="password"
        value={pass}
        onChange={(event) => setPass(event.target.value)}
        placeholder={
          hasPass ? `${t('settingsSyncPassword')}（已保存，留空不改）` : t('settingsSyncPassword')
        }
        style={fieldStyle}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button size="m" disabled={saving} onClick={() => void save()}>
          {t('settingsSyncSave')}
        </Button>
        {saved ? (
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-brand-text)' }}>
            {t('settingsSyncSaved')}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** 云端文件过多提醒：默认开启，可关闭。 */
const RemoteSizeWarningSetting = () => {
  const t = useTranslate()
  const remoteSizeWarning = useSettings((state) => state.remoteSizeWarning)
  return (
    <SettingCell
      label={t('settingsRemoteSizeWarning')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsRemoteSizeWarning')}
          value={remoteSizeWarning ? 'on' : 'off'}
          options={[
            { value: 'on', label: t('settingsOn') },
            { value: 'off', label: t('settingsOff') },
          ]}
          onChange={(value) => setRemoteSizeWarning(value === 'on')}
        />
      }
    />
  )
}


/** 通用：一个「标题 + 开关 + 列表 + 新增输入」的配置块。 */
type PromptListProps = {
  title: string
  detail: string
  example?: string
  placeholder: string
  emptyLabel: string
  /** 决定数量上限与单条字数上限 */
  kind: 'preferences' | 'memories'
  items: PromptItem[]
  onChange: (items: PromptItem[]) => void
  /** 导出到坚果云（可选） */
  onExport?: () => void
  /** 从坚果云导入（可选） */
  onImport?: () => void
}

const PromptListSetting = ({
  title,
  detail,
  example,
  placeholder,
  emptyLabel,
  kind,
  items,
  onChange,
  onExport,
  onImport,
}: PromptListProps) => {
  const t = useTranslate()
  const [draft, setDraft] = useState('')
  const [keyword, setKeyword] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')

  const limits = promptLimitsOf(kind)
  const kindLabel = kind === 'preferences' ? t('settingsPersonalPrompt') : t('settingsMemory')

  /** 撞上限时用 5 秒提示，比普通 toast 长，避免用户没看清就消失。 */
  const warnLimit = (message: Parameters<typeof showToast>[0]) => showToast(message, 5000)

  const add = () => {
    const value = draft.trim()
    if (!value) return
    if (items.length >= limits.maxItems) {
      warnLimit({ key: 'promptLimitCount', params: { kind: kindLabel, max: limits.maxItems } })
      return
    }
    if (value.length > limits.maxChars) {
      warnLimit({ key: 'promptLimitChars', params: { kind: kindLabel, max: limits.maxChars } })
      return
    }
    onChange([...items, { id: createId(), content: value }])
    setDraft('')
  }
  const remove = (id: string) => {
    onChange(items.filter((item) => item.id !== id))
  }
  const startEdit = (id: string, content: string) => {
    setEditingId(id)
    setEditingValue(content)
  }
  const saveEdit = () => {
    if (editingId === null) return
    const value = editingValue.trim()
    if (value) {
      if (value.length > limits.maxChars) {
        warnLimit({ key: 'promptLimitChars', params: { kind: kindLabel, max: limits.maxChars } })
        return
      }
      onChange(items.map((item) => (item.id === editingId ? { ...item, content: value } : item)))
    }
    setEditingId(null)
  }

  const filtered = items.filter((item) => !keyword.trim() || item.content.includes(keyword.trim()))

  const inputStyle = {
    flex: 1,
    minWidth: 0,
    boxSizing: 'border-box' as const,
    padding: '7px 10px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  }

  return (
    <div style={{ paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <span>
          {title}
          {items.length > 0 ? `（${items.length} ${t('settingsRows')}）` : ''}
          <span
            style={{
              marginLeft: 8,
              fontSize: 11,
              fontWeight: 400,
              color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
            }}
          >
            {t('promptLimitHint', { max: limits.maxItems, chars: limits.maxChars })}
          </span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {onImport ? (
          <button
            type="button"
            onClick={onImport}
            style={{
              padding: '3px 10px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            导入
          </button>
        ) : null}
        {onExport ? (
          <button
            type="button"
            onClick={onExport}
            style={{
              padding: '3px 10px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            导出全部
          </button>
        ) : null}
        {items.length > 0 ? (
          <button
            type="button"
            aria-label={t('settingsMemorySearch')}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((value) => !value)
              setKeyword('')
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              padding: 0,
              border: 'none',
              borderRadius: 6,
              background: searchOpen
                ? 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.05))'
                : 'transparent',
              color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
              cursor: 'pointer',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.3" />
              <path d="M10.4 10.4 13.6 13.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
        </div>
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
          marginBottom: 8,
          lineHeight: 1.6,
        }}
      >
        {detail}
      </div>
      {example ? (
        <div
          style={{
            fontSize: 12,
            color: 'var(--dsw-alias-label-secondary, #6b7280)',
            marginBottom: 8,
            lineHeight: 1.6,
            background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.03))',
            borderRadius: 8,
            padding: '6px 10px',
          }}
        >
          {example}
        </div>
      ) : null}
      {searchOpen && items.length > 0 ? (
        <input
          autoFocus
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t('settingsMemorySearch')}
          style={{ ...inputStyle, width: '100%', marginBottom: 8 }}
        />
      ) : null}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          marginBottom: 10,
        }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
              fontSize: 12,
              padding: '10px 2px',
            }}
          >
            {items.length === 0 ? emptyLabel : t('settingsMemoryNoMatch')}
          </div>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                padding: '6px 10px',
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.03))',
              }}
            >
              {editingId === item.id ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
                  <textarea
                    autoFocus
                    rows={5}
                    value={editingValue}
                    onChange={(event) => setEditingValue(event.target.value)}
                    onKeyDown={(event) => {
                      // Enter 与 Shift+Enter 都是换行；保存只靠「确定」按钮
                      if (event.key === 'Escape') {
                        setEditingId(null)
                      }
                    }}
                    style={{
                      ...inputStyle,
                      flex: 1,
                      padding: '6px 8px',
                      minHeight: 120,
                      lineHeight: 1.6,
                      resize: 'vertical',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      style={{
                        padding: '4px 14px',
                        borderRadius: 8,
                        border: '1px solid var(--dsw-alias-border-l2)',
                        background: 'transparent',
                        color: 'inherit',
                        font: 'inherit',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      {t('cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={saveEdit}
                      style={{
                        padding: '4px 14px',
                        borderRadius: 8,
                        border: '1px solid transparent',
                        background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
                        color: '#fff',
                        font: 'inherit',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      {t('confirm')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      lineHeight: 1.6,
                      textAlign: 'left',
                      wordBreak: 'break-word',
                      whiteSpace: 'pre-wrap',
                      display: '-webkit-box',
                      WebkitLineClamp: 5,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {item.content}
                  </span>
                  {(() => {
                    const charCount = item.content.trim().length
                    const overLimit = charCount > limits.maxChars
                    return (
                      <span
                        style={{
                          flexShrink: 0,
                          alignSelf: 'flex-start',
                          paddingTop: 2,
                          fontSize: 11,
                          whiteSpace: 'nowrap',
                          fontVariantNumeric: 'tabular-nums',
                          color: overLimit
                            ? '#d94040'
                            : 'var(--dsw-alias-label-tertiary, #8a8f99)',
                        }}
                        title={
                          overLimit
                            ? t('promptLimitChars', { kind: kindLabel, max: limits.maxChars })
                            : undefined
                        }
                      >
                        {charCount} {t('settingsChars')} · ~{charCount} {t('settingsTokens')}
                      </span>
                    )
                  })()}
                  <button
                    type="button"
                    aria-label={t('edit')}
                    onClick={() => startEdit(item.id, item.content)}
                    style={{
                      flexShrink: 0,
                      padding: '2px 8px',
                      borderRadius: 6,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
                      font: 'inherit',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    aria-label={t('delete')}
                    onClick={() => remove(item.id)}
                    style={{
                      flexShrink: 0,
                      padding: '2px 8px',
                      borderRadius: 6,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
                      font: 'inherit',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    {t('delete')}
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'flex-start' }}>
        <textarea
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          style={{
            ...inputStyle,
            minHeight: 72,
            lineHeight: 1.6,
            resize: 'vertical',
          }}
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          style={{
            flexShrink: 0,
            padding: '7px 14px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            cursor: draft.trim() ? 'pointer' : 'default',
            opacity: draft.trim() ? 1 : 0.5,
          }}
        >
          {t('settingsMemoryAdd')}
        </button>
      </div>
    </div>
  )
}

/** 「个人与记忆」分组：顶部左右切换；这里是内容管理，会话里按需关联后才注入。 */
const PersonalMemorySection = () => {
  const t = useTranslate()
  const [tab, setTab] = useState<'preferences' | 'memories'>('preferences')
  const preferences = useSettings((state) => state.preferences)
  const memories = useSettings((state) => state.memories)

  /** 导出到坚果云：chat/chat/个人偏好和记忆/{个人偏好|个人记忆}/{内容前8字}.txt（每条一个） */
  const exportPrompts = async (kind: 'preferences' | 'memories') => {
    const bridge = (
      window as unknown as {
        __syncBridge?: {
          uploadText?: (
            folder: string,
            subFolder: string,
            fileName: string,
            text: string
          ) => Promise<{ path: string }>
          listTextFiles?: (
            folder: string,
            subFolder: string
          ) => Promise<{ name: string; modified: string | null }[]>
        }
      }
    ).__syncBridge
    if (!bridge?.uploadText) {
      showToast('只有桌面版支持导出到坚果云')
      return
    }
    const items = kind === 'preferences' ? preferences : memories
    if (items.length === 0) {
      showToast('没有内容可导出')
      return
    }
    const picked = await pickPromptsForExport(
      items,
      kind === 'preferences' ? t('settingsPersonalPrompt') : t('settingsMemory')
    )
    if (!picked || picked.length === 0) return
    const subFolder = kind === 'preferences' ? '个人偏好' : '个人记忆'
    let remote: { name: string; modified: string | null }[] = []
    try {
      remote = (await bridge.listTextFiles?.('个人偏好和记忆', subFolder)) ?? []
    } catch {
      remote = []
    }
    const confirmOverwrite = useSettings.getState().confirmOverwrite
    let uploaded = 0
    let skipped = 0
    for (const item of picked) {
      const fileName = promptFileName(item.content)
      const existing = remote.find((file) => file.name === fileName)
      if (existing && confirmOverwrite) {
        const cloudMs = existing.modified ? new Date(existing.modified).getTime() : 0
        const ok = window.confirm(
          `云端已有「${fileName}」\n云端：${cloudMs ? new Date(cloudMs).toLocaleString('zh-CN') : '未知'}\n\n覆盖它吗？`
        )
        if (!ok) {
          skipped += 1
          continue
        }
      }
      await bridge.uploadText('个人偏好和记忆', subFolder, fileName, item.content)
      uploaded += 1
    }
    showToast(`已导出 ${uploaded} 条${skipped > 0 ? `，跳过 ${skipped} 条` : ''}`)
  }

  /** 从坚果云导入偏好/记忆：列 TXT → 勾选 → 读取 → 按内容去重合并。 */
  const importPrompts = async (kind: 'preferences' | 'memories') => {
    const bridge = (
      window as unknown as {
        __syncBridge?: {
          listTextFiles?: (
            folder: string,
            subFolder: string
          ) => Promise<{ name: string; modified: string | null }[]>
          downloadText?: (folder: string, subFolder: string, fileName: string) => Promise<string>
        }
      }
    ).__syncBridge
    if (!bridge?.downloadText) {
      showToast('只有桌面版支持从坚果云导入')
      return
    }
    const subFolder = kind === 'preferences' ? '个人偏好' : '个人记忆'
    let files: { name: string; modified: string | null }[] = []
    try {
      files = (await bridge.listTextFiles?.('个人偏好和记忆', subFolder)) ?? []
    } catch (error) {
      showToast(`读取失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (files.length === 0) {
      showToast('云端还没有导出过的条目')
      return
    }
    const chosen = await pickTextFilesToImport(
      files,
      kind === 'preferences' ? t('settingsPersonalPrompt') : t('settingsMemory')
    )
    if (!chosen || chosen.length === 0) return
    const current = kind === 'preferences' ? preferences : memories
    const existingContents = new Set(current.map((item) => item.content))
    const additions: PromptItem[] = []
    for (const fileName of chosen) {
      try {
        const text = await bridge.downloadText('个人偏好和记忆', subFolder, fileName)
        const content = text.trim()
        if (content && !existingContents.has(content)) {
          existingContents.add(content)
          additions.push({ id: createId(), content })
        }
      } catch {
        // 单个失败不影响其他
      }
    }
    if (additions.length === 0) {
      showToast('没有新的条目（都已存在）')
      return
    }
    if (kind === 'preferences') {
      setPreferences([...preferences, ...additions])
    } else {
      setMemories([...memories, ...additions])
    }
    showToast(`已导入 ${additions.length} 条`)
  }

  const tabStyle = (active: boolean) => ({
    flex: 1,
    padding: '8px 12px',
    borderRadius: 8,
    border: active ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2)',
    background: active ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'transparent',
    color: active ? '#fff' : 'inherit',
    font: 'inherit',
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '12px 14px',
          borderRadius: 10,
          background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.03))',
          color: 'var(--dsw-alias-label-secondary, #6b7280)',
          lineHeight: 1.7,
          marginBottom: 14,
        }}
      >
        {t('settingsPersonalIntro')}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        <button type="button" onClick={() => setTab('preferences')} style={tabStyle(tab === 'preferences')}>
          {t('settingsPersonalPrompt')}
        </button>
        <button type="button" onClick={() => setTab('memories')} style={tabStyle(tab === 'memories')}>
          {t('settingsMemory')}
        </button>
      </div>

      {tab === 'preferences' ? (
        <PromptListSetting
          title={t('settingsPersonalPrompt')}
          detail={t('settingsPersonalPromptDetail')}
          example={t('settingsPersonalPromptExample')}
          placeholder={t('settingsPersonalPromptHint')}
          emptyLabel={t('settingsPreferencesEmpty')}
          kind="preferences"
          items={preferences}
          onChange={setPreferences}
          onExport={() => exportPrompts('preferences')}
          onImport={() => importPrompts('preferences')}
        />
      ) : (
        <PromptListSetting
          title={t('settingsMemory')}
          detail={t('settingsMemoryDetail')}
          example={t('settingsMemoryExample')}
          placeholder={t('settingsMemoryHint')}
          emptyLabel={t('settingsMemoryEmpty')}
          kind="memories"
          items={memories}
          onChange={setMemories}
          onExport={() => exportPrompts('memories')}
          onImport={() => importPrompts('memories')}
        />
      )}
    </div>
  )
}
/** 通用：布尔开关（开启/关闭下拉）。 */
const BooleanSetting = ({
  label,
  description,
  value,
  onChange,
}: {
  label: string
  description?: string
  value: boolean
  onChange: (next: boolean) => void
}) => (
  <SettingCell
    label={label}
    description={description}
    status={null}
    action={
      <Select
        ariaLabel={label}
        value={value ? 'on' : 'off'}
        options={[
          { value: 'on', label: '开启' },
          { value: 'off', label: '关闭' },
        ]}
        onChange={(next) => onChange(next === 'on')}
      />
    }
  />
)

/** 关于：版本、开源信息、链接、免责声明。 */
const AboutSection = () => {
  const repo = 'https://github.com/yingjian666/deepseek-chat-webdav-jianguoyun'
  const [updateState, setUpdateState] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  // 版本号从主进程读取（package.json），避免和 package.json / version.json 三处不一致
  const [version, setVersion] = useState('1.0.0')
  useEffect(() => {
    const bridge = (window as unknown as { __syncBridge?: { getAppVersion?: () => Promise<string> } })
      .__syncBridge
    void bridge
      ?.getAppVersion?.()
      .then((value) => {
        if (value) setVersion(value)
      })
      .catch(() => undefined)
  }, [])
  const checkUpdate = async () => {
    const bridge = (
      window as unknown as {
        __syncBridge?: {
          checkUpdate?: () => Promise<{
            ok: boolean
            current: string
            latest?: string | null
            downloadUrl?: string | null
            downloads?: Record<string, string> | null
            notes?: string
            bestSource?: string
            sources?: { source: string; latency: number | null; ok: boolean; error?: string }[]
            error?: string
          }>
          downloadUpdate?: (url: string) => Promise<{ path: string; bytes: number }>
        }
      }
    ).__syncBridge
    if (!bridge?.checkUpdate) {
      showToast('只有桌面版支持检查更新')
      return
    }
    setChecking(true)
    setUpdateState('正在检查三个更新源…')
    try {
      const result = await bridge.checkUpdate()
      if (!result.ok) {
        const detail = (result.sources ?? [])
          .map((item) => `${item.source} ${item.ok ? `${item.latency}ms` : item.error ?? '不可达'}`)
          .join(' ｜ ')
        // 三个源都是 404 → 版本信息还没发布；否则按网络问题提示
        const all404 = (result.sources ?? []).every(
          (item) => !item.ok && (item.error ?? '').includes('404')
        )
        setUpdateState(
          all404
            ? '云端还没有版本信息（version.json 未发布）'
            : `检查失败：${result.error ?? '网络错误'}\n各源状态：${detail}`
        )
        return
      }
      const sourceText = (result.sources ?? [])
        .map((item) => `${item.source}${item.ok ? ` ${item.latency}ms` : ' 不可达'}`)
        .join(' ｜ ')
      if (!result.latest) {
        setUpdateState(`各源状态：${sourceText}\n云端还没有版本信息（version.json 未发布）`)
        return
      }
      if (result.latest === result.current) {
        setUpdateState(`已是最新版本（v${result.current}）\n各源状态：${sourceText}`)
        return
      }
      // 发现新版本：先弹窗确认
      const ok = window.confirm(
        `发现新版本 v${result.latest}（当前 v${result.current}）\n${result.notes ?? ''}\n\n是否立即下载更新？`
      )
      if (!ok) {
        setUpdateState(`已取消更新（最新 v${result.latest}）\n各源状态：${sourceText}`)
        return
      }
      const downloadUrl =
        (result.bestSource ? result.downloads?.[result.bestSource] : null) ?? result.downloadUrl
      if (!downloadUrl || !bridge.downloadUpdate) {
        setUpdateState('没有可用的下载地址')
        return
      }
      setUpdateState(`正在从 ${result.bestSource ?? '默认源'} 下载更新…`)
      const downloaded = await bridge.downloadUpdate(downloadUrl)
      setUpdateState(
        `下载完成（${(downloaded.bytes / 1024 / 1024).toFixed(1)}MB）：${downloaded.path}`
      )
    } catch (error) {
      setUpdateState(`检查失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setChecking(false)
    }
  }
  const copyRepo = async () => {
    try {
      await navigator.clipboard.writeText(repo)
      showToast('仓库地址已复制')
    } catch {
      showToast('复制失败，请手动复制')
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 14,
            background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.04))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 26,
          }}
        >
          🐋
        </div>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>ChatDesktop</div>
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a8f99)' }}>
            支持 DeepSeek API · v{version}
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: 12,
          lineHeight: 1.8,
          color: 'var(--dsw-alias-label-secondary, #5c6169)',
          background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.03))',
          borderRadius: 10,
          padding: '10px 14px',
        }}
      >
        基于 DeepSeek 官方开源的 chat-demo 打造的桌面客户端。
        <br />
        对话历史可通过坚果云 WebDAV 手动同步（可选，不填也能正常聊天）。
        <br />
        数据只发往 DeepSeek API 和你的坚果云，不经过任何第三方中转；不上传使用统计。
        <br />
        详细说明见仓库根目录的 <b>PRIVACY.md</b>（隐私）与 <b>COMPLIANCE.md</b>（第三方服务与免责）。
      </div>

      <SettingCell
        label="GitHub 仓库"
        description="源码、更新与问题反馈"
        status={null}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              style={{
                fontSize: 11,
                color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
                maxWidth: 260,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {repo}
            </span>
            <Button variant="outlined" size="m" className={styles.cellButton} onClick={copyRepo}>
              复制
            </Button>
          </div>
        }
      />

      <SettingCell
        label="检查更新"
        description="从云端 version.json 读取最新版本（jsDelivr CDN）"
        status={null}
        action={
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            onClick={checkUpdate}
            disabled={checking}
          >
            {checking ? '检查中…' : '检查'}
          </Button>
        }
      />
      {updateState ? (
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.8,
            color: 'var(--dsw-alias-label-secondary, #5c6169)',
            whiteSpace: 'pre-line',
          }}
        >
          {updateState}
        </div>
      ) : null}

      <SettingCell
        label="开源许可"
        description="chat-demo（MIT License）、Electron（MIT License）、DeepSeek 及坚果云商标归各自所有者"
        status={null}
        action={<span />}
      />

      <div
        style={{
          fontSize: 12,
          lineHeight: 1.9,
          color: 'var(--dsw-alias-label-secondary, #5c6169)',
          borderTop: '1px solid var(--dsw-alias-border-l1)',
          paddingTop: 12,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>免责声明</div>
        <div>• 本软件是第三方客户端，非 DeepSeek 或坚果云官方产品，也未获得其官方认证。</div>
        <div>
          • 坚果云同步是本软件基于公开 WebDAV 接口自行实现的功能，<b>不是坚果云官方功能</b>，也未获其支持。
        </div>
        <div>• 对话内容由 AI 生成，请自行甄别。</div>
        <div>
          • 坚果云同步遵守其服务条款与限制（单文件 500MB；免费版每 30 分钟 600 次请求；单次目录 750
          个文件）。
        </div>
        <div>• 因账号被限流、封禁或数据丢失产生的风险由使用者自行承担。</div>
      </div>
    </div>
  )
}

/** 坚果云账号配置：账号 + 所有同步相关开关。 */
const SyncAccountSection = () => {
  const t = useTranslate()
  const confirmOverwrite = useSettings((state) => state.confirmOverwrite)
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '12px 14px',
          borderRadius: 10,
          background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.03))',
          color: 'var(--dsw-alias-label-secondary, #6b7280)',
          lineHeight: 1.7,
          marginBottom: 4,
        }}
      >
        {t('settingsSyncSectionIntro')}
      </div>
      <SyncAccountSetting />
      <RemoteSizeWarningSetting />
      <BooleanSetting
        label="上传前提示覆盖确认"
        description="云端已有同名对话备份时，上传前弹窗询问是否覆盖。"
        value={confirmOverwrite}
        onChange={setConfirmOverwrite}
      />
    </div>
  )
}

/** 重看新手引导：关闭设置后重新播放引导。 */
const OnboardingSetting = () => {
  const t = useTranslate()
  return (
    <SettingCell
      label={t('settingsOnboarding')}
      description={t('settingsOnboardingDesc')}
      status={null}
      action={
        <button
          type="button"
          onClick={() => {
            closeSettings()
            window.dispatchEvent(new Event('chat:onboarding'))
          }}
          style={{
            padding: '5px 12px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {t('settingsOnboardingReplay')}
        </button>
      }
    />
  )
}

/** 「思维链漂移」分组：开关 + 三段说明。 */
const DriftSection = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.driftSuppression)
  const labelStyle = { fontWeight: 600, marginBottom: 2 }
  const textStyle = { color: 'var(--dsw-alias-label-secondary, #6b7280)' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div
        style={{
          padding: '12px 14px',
          borderRadius: 10,
          background: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.03))',
          color: 'var(--dsw-alias-label-secondary, #6b7280)',
          lineHeight: 1.7,
        }}
      >
        {t('settingsDriftBrief')}
      </div>

      <div
        style={{
          fontSize: 11,
          lineHeight: 1.6,
          color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
          marginTop: -6,
        }}
      >
        {t('systemPromptCacheHint')}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-border-l2)',
        }}
      >
        <span style={{ fontWeight: 600 }}>{t('settingsDriftEnable')}</span>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
          <button
            type="button"
            onClick={() => setDriftSuppression(true)}
            style={{
              padding: '5px 16px',
              borderRadius: 8,
              border: enabled ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2)',
              background: enabled ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'transparent',
              color: enabled ? '#fff' : 'inherit',
              font: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {t('settingsDriftOpen')}
          </button>
          <button
            type="button"
            onClick={() => setDriftSuppression(false)}
            style={{
              padding: '5px 16px',
              borderRadius: 8,
              border: enabled ? '1px solid var(--dsw-alias-border-l2)' : '1px solid transparent',
              background: enabled ? 'transparent' : 'var(--dsw-alias-brand-primary, #4d6bfe)',
              color: enabled ? 'inherit' : '#fff',
              font: 'inherit',
              fontSize: 12,
              fontWeight: enabled ? 400 : 600,
              cursor: 'pointer',
            }}
          >
            {t('settingsDriftClose')}
          </button>
        </div>
      </div>

      <section style={{ lineHeight: 1.7 }}>
        <div style={labelStyle}>{t('settingsDriftWhatTitle')}</div>
        <div style={textStyle}>{t('settingsDriftWhat')}</div>
      </section>
      <section style={{ lineHeight: 1.7 }}>
        <div style={labelStyle}>{t('settingsDriftWhyTitle')}</div>
        <div style={textStyle}>{t('settingsDriftWhy')}</div>
      </section>
      <section style={{ lineHeight: 1.7 }}>
        <div style={labelStyle}>{t('settingsDriftEffectTitle')}</div>
        <div style={textStyle}>{t('settingsDriftEffect')}</div>
      </section>
      <section style={{ lineHeight: 1.7 }}>
        <div style={labelStyle}>{t('settingsDriftExampleTitle')}</div>
        <div style={textStyle}>{t('settingsDriftExample')}</div>
      </section>
    </div>
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<{ processed: number; total?: number } | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    const target = file
    setFile(null)
    setProgress({ processed: 0 })
    setStatus(null)
    try {
      // 先解析 ZIP 索引，让用户勾选要导入的对话（默认全选）
      const data = new Uint8Array(await target.arrayBuffer())
      const index = await readArchiveIndex(data)
      if (index.length > 0) {
        const selected = await pickImportSessions(index, target.name)
        if (!selected) {
          // 用户取消，不导入
          importing.current = false
          setProgress(null)
          return
        }
        const count = await importSelectedSessions(target, selected, (processed, total) =>
          setProgress({ processed, total })
        )
        setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
      } else {
        // 索引缺失（老文件）：退化为全部合并
        const count = await importArchiveMerged(target, (processed, total) =>
          setProgress({ processed, total })
        )
        setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
      }
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setProgress(null)
    }
  }

  return {
    file,
    busy: progress !== null,
    progress,
    status,
    select: setFile,
    cancel: () => setFile(null),
    dismiss: () => {
      setFile(null)
      setStatus(null)
    },
    confirm,
  }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const { progress } = historyImport

  return (
    <SettingCell
      className={progress ? styles.importing : undefined}
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            aria-busy={historyImport.busy}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {progress ? (
              <IconLoadingOutline16 />
            ) : (
              <>
                <IconUploadOutline14 />
                {t('historyImportButton')}
              </>
            )}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
          {progress ? (
            <div className={styles.importProgress}>
              {progress.total !== undefined ? (
                <div
                  className={styles.importTrack}
                  role="progressbar"
                  aria-label={t('historyImport')}
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.processed}
                >
                  <span
                    style={{
                      width: `${progress.total ? (progress.processed / progress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              ) : null}
              <span>
                {progress.total !== undefined
                  ? `${progress.processed} / ${progress.total}`
                  : `已处理 ${progress.processed} 个`}
              </span>
            </div>
          ) : null}
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('historyExportButton')}
        </Button>
      }
    />
  )
}
