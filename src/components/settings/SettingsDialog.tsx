import clsx from 'clsx'
import { useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setSyncBranch,
  setSyncEnabled,
  setSyncRepo,
  setSyncToken,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import {
  confirmRemoteReset,
  dismissRemoteReset,
  resetSyncTarget,
  syncNow,
  useSyncStatus,
  validateSyncTarget,
} from '../../services/sync/sync.js'
import { GitHubError, type GitHubErrorKind } from '../../services/sync/github.js'
import { parseRepoInput } from '../../services/sync/repoInput.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const needsConfirm = useSyncStatus((state) => state.needsConfirm)
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
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
            </>
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SyncSetting disabled={historyBusy} />
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
      {needsConfirm ? <SyncResetConfirm /> : null}
    </>
  )
}

/** 远端被另一台设备清空时的确认；跟随会删除本地全部会话与附件。 */
const SyncResetConfirm = () => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    setBusy(true)
    try {
      await confirmRemoteReset()
    } catch {
      showToast({ key: 'syncFailed', type: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('syncNeedsConfirmTitle')}
      className={styles.deleteConfirm}
      onClose={dismissRemoteReset}
      footer={
        <div className={styles.deleteActions} aria-busy={busy}>
          <Button variant="outlined" autoFocus disabled={busy} onClick={dismissRemoteReset}>
            {t('syncNeedsConfirmDismiss')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void confirm()}>
            {t('syncNeedsConfirmFollow')}
          </Button>
        </div>
      }
    >
      {t('syncNeedsConfirmDescription')}
    </Modal>
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
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const count = await importHistory(file)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
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

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
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
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}

const syncErrorKeys: Record<GitHubErrorKind, TranslationKey> = {
  auth: 'syncErrorAuth',
  'not-found': 'syncErrorNotFound',
  'rate-limit': 'syncErrorRateLimit',
  network: 'syncErrorNetwork',
  server: 'syncErrorServer',
  protocol: 'syncErrorServer',
}

const syncErrorKey = (error: unknown): TranslationKey =>
  error instanceof GitHubError ? syncErrorKeys[error.kind] : 'syncErrorServer'

type SyncCheck =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'done'; repo: string; private: boolean; branchExists: boolean }
  | { kind: 'error'; key: TranslationKey }

/** 一周内到期就提醒，避免同步忽然失效。 */
const expiryWarningMs = 7 * 24 * 60 * 60 * 1000

/**
 * 跨设备同步：仓库、分支、Token 三个输入保存到本机，
 * 手动同步不受自动开关限制；自动开关需要配置完整后才能打开。
 */
const SyncSetting = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const syncRepo = useSettings((state) => state.syncRepo)
  const syncBranch = useSettings((state) => state.syncBranch)
  const syncToken = useSettings((state) => state.syncToken)
  const syncEnabled = useSettings((state) => state.syncEnabled)
  const syncTokenExpiresAt = useSettings((state) => state.syncTokenExpiresAt)
  const status = useSyncStatus((state) => state.status)
  const lastSyncedAt = useSyncStatus((state) => state.lastSyncedAt)
  const lastError = useSyncStatus((state) => state.lastError)
  const lastErrorKind = useSyncStatus((state) => state.lastErrorKind)
  const pendingFiles = useSyncStatus((state) => state.pendingFiles)
  const [repo, setRepo] = useState(syncRepo)
  const [branch, setBranch] = useState(syncBranch)
  const [token, setToken] = useState(syncToken ?? '')
  const [check, setCheck] = useState<SyncCheck>({ kind: 'idle' })

  /** 失焦时保存输入；仓库或分支变化后丢弃旧的远端路径缓存。 */
  const commit = async () => {
    let targetChanged = false
    const parsed = parseRepoInput(repo)
    const nextRepo = parsed ? `${parsed.owner}/${parsed.repo}` : repo.trim()
    const nextBranch = branch.trim() || 'main'
    // 粘贴完整 URL 后统一存成 owner/repo。
    if (parsed && nextRepo !== repo) {
      setRepo(nextRepo)
    }
    if (nextRepo !== syncRepo) {
      setSyncRepo(nextRepo)
      targetChanged = true
    }
    if (nextBranch !== syncBranch) {
      setSyncBranch(nextBranch)
      targetChanged = true
    }
    const nextToken = token.trim()
    if (nextToken !== (syncToken ?? '')) {
      setSyncToken(nextToken || null)
    }
    if (targetChanged) {
      await resetSyncTarget()
    }
  }

  /** 归一化仓库地址后立即校验；失败原因按类型展示。 */
  const validate = async () => {
    const target = parseRepoInput(repo)
    if (!target) {
      setCheck({ kind: 'error', key: 'syncInvalidRepo' })
      return
    }
    await commit()
    setCheck({ kind: 'checking' })
    try {
      const result = await validateSyncTarget()
      setCheck({
        kind: 'done',
        repo: `${result.owner}/${result.repo}`,
        private: result.private,
        branchExists: result.branchExists,
      })
    } catch (error) {
      setCheck({ kind: 'error', key: syncErrorKey(error) })
    }
  }

  const configured =
    parseRepoInput(repo) !== null && branch.trim() !== '' && token.trim() !== ''
  const repoInvalid = repo.trim() !== '' && parseRepoInput(repo) === null
  const showGuide = repo.trim() === '' && token.trim() === ''
  const checking = check.kind === 'checking'

  const run = async () => {
    await commit()
    await syncNow('manual')
  }

  const errorText = lastErrorKind
    ? t(syncErrorKeys[lastErrorKind])
    : lastError
      ? t('syncLastError', { message: lastError })
      : null
  const tokenExpired = syncTokenExpiresAt !== null && syncTokenExpiresAt <= Date.now()
  const tokenExpiringSoon =
    syncTokenExpiresAt !== null &&
    !tokenExpired &&
    syncTokenExpiresAt - Date.now() < expiryWarningMs

  return (
    <div className={clsx(styles.cell, styles.sync)}>
      <div className={styles.syncHeader}>
        <div className={styles.text}>
          <div className={styles.label}>{t('syncTitle')}</div>
          <div className={styles.description}>{t('syncDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || !configured || status === 'syncing'}
          onClick={() => void run()}
        >
          {t(status === 'syncing' ? 'syncing' : 'syncNow')}
        </Button>
      </div>
      {showGuide ? (
        <div className={styles.syncGuide}>
          <div className={styles.syncGuideStep}>
            <span>{t('syncGuideRepo')}</span>
            <a
              className={styles.syncGuideLink}
              href="https://github.com/new?name=chat-demo-data&visibility=private"
              target="_blank"
              rel="noreferrer"
            >
              {t('syncGuideRepoAction')}
            </a>
          </div>
          <div className={styles.syncGuideStep}>
            <span>{t('syncGuideToken')}</span>
            <a
              className={styles.syncGuideLink}
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noreferrer"
            >
              {t('syncGuideTokenAction')}
            </a>
          </div>
          <div className={styles.syncGuideStep}>{t('syncGuidePaste')}</div>
        </div>
      ) : null}
      <div className={styles.syncFields}>
        <label className={styles.syncField}>
          <span>{t('syncRepoLabel')}</span>
          <span className={styles.apiKeyInput}>
            <input
              value={repo}
              placeholder={t('syncRepoPlaceholder')}
              spellCheck={false}
              onChange={(event) => {
                setRepo(event.target.value)
                setCheck({ kind: 'idle' })
              }}
              onBlur={() => void (token.trim() ? validate() : commit())}
            />
          </span>
          {repoInvalid ? <span className={styles.error}>{t('syncInvalidRepo')}</span> : null}
        </label>
        <label className={styles.syncField}>
          <span>{t('syncBranchLabel')}</span>
          <span className={styles.apiKeyInput}>
            <input
              value={branch}
              placeholder={t('syncBranchPlaceholder')}
              spellCheck={false}
              onChange={(event) => {
                setBranch(event.target.value)
                setCheck({ kind: 'idle' })
              }}
              onBlur={() => void (token.trim() ? validate() : commit())}
            />
          </span>
        </label>
      </div>
      <label className={styles.syncField}>
        <span>{t('syncTokenLabel')}</span>
        <span className={styles.apiKeyInput}>
          <input
            type="password"
            value={token}
            placeholder={t('syncTokenPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setToken(event.target.value)
              setCheck({ kind: 'idle' })
            }}
            onBlur={() =>
              void (token.trim() && token.trim() !== (syncToken ?? '') ? validate() : commit())
            }
          />
          {token ? (
            <button
              type="button"
              className={styles.confirm}
              onClick={() => {
                setToken('')
                setSyncToken(null)
                setCheck({ kind: 'idle' })
              }}
            >
              {t('syncTokenClear')}
            </button>
          ) : null}
        </span>
      </label>
      <div className={styles.description}>{t('syncTokenHelp')}</div>
      <div className={styles.syncCheck}>
        <Button
          variant="outlined"
          size="s"
          disabled={disabled || !configured || checking || status === 'syncing'}
          onClick={() => void validate()}
        >
          {t(checking ? 'syncValidating' : 'syncValidate')}
        </Button>
        {check.kind === 'checking' ? (
          <span className={styles.description}>{t('syncValidating')}</span>
        ) : check.kind === 'error' ? (
          <span className={styles.error}>{t(check.key)}</span>
        ) : check.kind === 'done' ? (
          <span className={clsx(styles.description, !check.private && styles.warning)}>
            {check.private
              ? t('syncConnected', { repo: check.repo })
              : t('syncPublicRepo')}
          </span>
        ) : null}
      </div>
      {check.kind === 'done' && !check.branchExists ? (
        <div className={styles.description}>{t('syncBranchWillCreate')}</div>
      ) : null}
      {tokenExpired ? (
        <div className={styles.error}>{t('syncTokenExpired')}</div>
      ) : tokenExpiringSoon && syncTokenExpiresAt !== null ? (
        <div className={styles.warning}>
          {t('syncTokenExpirySoon', {
            time: new Date(syncTokenExpiresAt).toLocaleString(locale),
          })}
        </div>
      ) : null}
      <div className={styles.syncStatus}>
        <span className={clsx(styles.description, errorText && styles.error)}>
          {status === 'syncing'
            ? t('syncing')
            : errorText
              ? errorText
              : lastSyncedAt
                ? t('syncLastAt', { time: new Date(lastSyncedAt).toLocaleString(locale) })
                : t('syncNever')}
        </span>
        {pendingFiles > 0 ? (
          <span className={styles.error}>{t('syncPendingFiles', { count: pendingFiles })}</span>
        ) : null}
      </div>
      <label className={styles.syncToggle}>
        <input
          type="checkbox"
          checked={syncEnabled}
          disabled={!configured}
          onChange={(event) => {
            const checked = event.target.checked
            void commit().then(() => setSyncEnabled(checked))
          }}
        />
        <span className={styles.syncToggleText}>
          {t('syncAuto')}
          <span className={styles.description}>{t('syncAutoHint')}</span>
        </span>
      </label>
    </div>
  )
}
