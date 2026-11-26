import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { closeSettings, openSettings, ONBOARDED_KEY } from '../settings/settingsDialogState.js'

/** 引导步骤：目标可以是页面元素（data-tour）或一张截图。 */
type TourStep = {
  /** data-tour 选择器；image 步骤不用 */
  tour: string
  title: string
  desc?: string
  /** 显示的截图（assets 下的文件，构建后复制到 dist/assets） */
  image?: string
  /**
   * 截图在窗口中的位置与尺寸（模拟真实位置）。
   * width/height 必须写死：图片是异步加载的，若靠 naturalWidth 撑开，
   * 切换步骤时 getBoundingClientRect() 会先拿到上一张图的尺寸，导致定位滞后。
   * left 与 right 二选一：右侧固定元素（如对话导航）用 right，窗口缩放时保持贴右。
   */
  imageBox?: { top: number; left?: number; right?: number; width: number; height: number }
}

const IMG_MENU = 'assets/menu-sync-crop.png'
const IMG_LIST = 'assets/session-list-crop.png'
const IMG_MENU_OPEN = 'assets/session-menu-crop.png'
const IMG_NAV = 'assets/nav-crop.png'

const steps: TourStep[] = [
  {
    tour: 'menu-image',
    title: '顶部菜单：对话同步',
    desc:
      '窗口顶部菜单栏的「对话同步」：\n' +
      '• 上传到坚果云：把选中的对话备份到云端（按对话单独 ZIP）\n' +
      '• 从坚果云导入：选择日期文件夹 → 选择对话 → 按 id 合并\n' +
      '• 注意：坚果云同步是第三方接入（非坚果云官方功能），需要你有坚果云账号',
    image: IMG_MENU,
    imageBox: { top: 8, left: 8, width: 170, height: 100 },
  },
  {
    tour: 'collapse',
    title: '收起侧边栏',
    desc: '点这里的图标可以收起或展开左侧会话列表，给聊天留出更多空间。',
  },
  {
    tour: 'input',
    title: '输入框',
    desc: '在这里输入你的问题。回车发送，Shift + 回车换行。',
  },
  {
    tour: 'thinking',
    title: '深度思考',
    desc: '开启后模型先推理再回答，适合复杂问题。官方默认关闭，按需打开。',
  },
  {
    tour: 'search',
    title: '智能搜索',
    desc: '需要最新信息时打开，模型会联网搜索。官方默认关闭。',
  },
  {
    tour: 'model',
    title: '模型选择',
    desc: '默认 V4.1-Flash（全能、支持图片）；V4-Pro 推理更强，但不支持图片、token 消耗更高。',
  },
  {
    tour: 'voice',
    title: '语音输入',
    desc:
      '点一下开始录音，再点一下结束，说的话会自动转成文字填进输入框。\n' +
      '需要麦克风授权和 API Key；单次最长 120 秒，录满会自动结束。',
  },
  {
    tour: 'attach',
    title: '上传附件',
    desc:
      '点这里选择文件（图片、PDF、Word/Excel、代码等），也可以直接把文件拖进输入框。\n' +
      '图片会随对话一起保存，导出和同步到云端时也会带上。',
  },
  {
    tour: 'send',
    title: '发送',
    desc: '点这里发送消息，也可以直接按回车。',
  },
  {
    tour: 'newchat',
    title: '新建对话',
    desc: '每个新话题建议开一个新对话，历史会保存在左侧列表里。',
  },
  {
    tour: 'list-image',
    title: '对话列表',
    desc:
      '对话会按时间分组显示在左侧（今天/昨天/7 天内/更早）。\n' +
      '同一话题的分叉对话会缩进显示在父对话下面，点三角可以折叠。',
    image: IMG_LIST,
    imageBox: { top: 70, left: 8, width: 260, height: 365 },
  },
  {
    tour: 'nav-image',
    title: '对话导航',
    desc:
      '长对话时，聊天区右侧会出现一列小横线，每条代表一轮提问。\n' +
      '鼠标移上去会向左展开，显示每轮问题的开头；点任意一行直接跳到那一轮，滚轮可以翻历史。',
    image: IMG_NAV,
    imageBox: { top: 76, right: 8, width: 245, height: 416 },
  },
  {
    tour: 'menu-image',
    title: '会话菜单：重命名',
    desc: '鼠标移到对话上，点右侧的 ⋯ 打开菜单。\n重命名：给这个对话换个更好记的名字。',
    image: IMG_MENU_OPEN,
    imageBox: { top: 70, left: 60, width: 260, height: 220 },
  },
  {
    tour: 'menu-image',
    title: '会话菜单：置顶对话',
    desc: '置顶对话：把重要对话固定到列表最上面。',
    image: IMG_MENU_OPEN,
    imageBox: { top: 70, left: 60, width: 260, height: 220 },
  },
  {
    tour: 'menu-image',
    title: '会话菜单：关联记忆与偏好',
    desc: '关联记忆与偏好：让模型在这个对话里参考你设置的个人信息（设置 → 个人与记忆）。',
    image: IMG_MENU_OPEN,
    imageBox: { top: 70, left: 60, width: 260, height: 220 },
  },
  {
    tour: 'menu-image',
    title: '会话菜单：分叉对话',
    desc:
      '分叉对话：把整段对话复制成一个新分支（复制到最后一条消息为止），适合尝试不同回答。\n' +
      '分支会缩进显示在父对话下面，点三角可以折叠；删除父对话时子对话会一起删除。\n' +
      '分层限制：一个对话最多分 3 个，每个分支还能再分 3 个，到第二层就不能再分了。\n' +
      '（只想从中间某条回答分叉，用那条回答下方的 ⑂ 按钮。）',
    image: IMG_MENU_OPEN,
    imageBox: { top: 70, left: 60, width: 260, height: 220 },
  },
  {
    tour: 'menu-image',
    title: '会话菜单：删除',
    desc: '删除：删除这个对话（分叉的子对话会一起删除）。',
    image: IMG_MENU_OPEN,
    imageBox: { top: 70, left: 60, width: 260, height: 220 },
  },
  {
    tour: 'settings',
    title: '设置',
    desc: 'API Key、坚果云同步、字号、个人与记忆都在这里。\n如果以后想再看一遍这个引导，可以在 设置 → 通用设置 →「新手引导」里重新播放。',
  },
]

const KEY = ONBOARDED_KEY
const BUBBLE_WIDTH = 420

/**
 * 新手引导：遮罩高亮目标 + 箭头 + 说明气泡。
 * - 截图步骤：在真实位置显示截图，箭头指向截图
 * - 普通步骤：高亮 data-tour 元素
 * - 不强制读秒；箭头用 atan2 支持 45° 等任意角度
 * - 完成时：首次引导打开 API Key 设置；重看引导不打开
 */
export const Onboarding = () => {
  const [active, setActive] = useState(() => localStorage.getItem(KEY) !== '1')
  const [step, setStep] = useState(0)
  const [position, setPosition] = useState<{ step: number; rect: DOMRect | null }>({ step: 0, rect: null })
  const rect = position.step === step ? position.rect : null
  const [bubbleHeight, setBubbleHeight] = useState(220)
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  // 测量气泡真实高度：必须放在 useLayoutEffect（绘制前）里。
  // 用 useEffect 会在绘制后才测量，第一帧按默认高度算位置 → 切换步骤时气泡会跳一下。
  // 同时观察气泡自身尺寸（窗口缩放会改变换行和高度）。
  useLayoutEffect(() => {
    if (!active) return
    const el = bubbleRef.current
    if (!el) return
    const measure = () => {
      const h = el.getBoundingClientRect().height
      setBubbleHeight((prev) => (Math.abs(prev - h) > 0.5 ? h : prev))
    }
    measure()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    return () => ro?.disconnect()
  }, [active, step])

  // 定位目标：截图步骤用图片的 rect；普通步骤用 data-tour 元素。
  // useLayoutEffect 在绘制前同步算好位置，避免「先指旧目标再跳」。
  useLayoutEffect(() => {
    if (!active) return
    const s = steps[step]

    const target = (): Element | null =>
      s.image
        ? document.querySelector('[data-tour-image]')
        : document.querySelector(`[data-tour="${s.tour}"]`)
    const locate = () => {
      const el = target()
      return el ? el.getBoundingClientRect() : null
    }

    setPosition({ step, rect: locate() })

    // 尺寸变化时重新定位（图片解码完成、布局变动）。
    // 截图尺寸已写死，正常不触发；这里兜底将来换图尺寸不一致的情况。
    const el = target()
    let ro: ResizeObserver | null = null
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => setPosition({ step, rect: locate() }))
      ro.observe(el)
    }
    const onResize = () => setPosition({ step, rect: locate() })
    window.addEventListener('resize', onResize)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [active, step])

  // 预加载引导截图，避免第一次切到截图步骤时空白一瞬
  useEffect(() => {
    for (const s of steps) {
      if (s.image) {
        const img = new Image()
        img.src = s.image
      }
    }
  }, [])

  // 设置里「重看新手引导」触发
  useEffect(() => {
    const handler = () => {
      // 重看引导时先关掉设置，否则设置窗口会盖在引导下面
      closeSettings()
      setActive(true)
      setStep(0)
    }
    window.addEventListener('chat:onboarding', handler)
    return () => window.removeEventListener('chat:onboarding', handler)
  }, [])

  if (!active) return null

  const current = steps[step]
  const last = step === steps.length - 1

  const finish = () => {
    const wasOnboarded = localStorage.getItem(KEY) === '1'
    localStorage.setItem(KEY, '1')
    setActive(false)
    if (!wasOnboarded) {
      openSettings('data')
    }
  }
  const next = () => {
    if (last) {
      finish()
    } else {
      setStep(step + 1)
    }
  }
  const back = () => {
    if (step > 0) setStep(step - 1)
  }

  // 气泡位置：目标下方优先，空间不够就上方；最后 clamp 进视口（防截断）
  const GAP = 56
  const VIEW_PAD = 16
  // 右侧多留一点，避免气泡贴着窗口右边（目标在最右侧时看起来不平衡）
  const RIGHT_PAD = 48
  // 窄窗口时气泡自适应；必须配 boxSizing: border-box，否则 padding/border 会让实际宽度
  // 超过这里算的 bubbleW，右边缘被窗口裁掉（踩坑 46）
  const bubbleW = Math.max(240, Math.min(BUBBLE_WIDTH, window.innerWidth - VIEW_PAD * 2))
  let bubbleStyle: CSSProperties = {
    position: 'fixed',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    width: bubbleW,
    boxSizing: 'border-box',
  }
  let arrowAngle = 0
  let arrowLeft = '50%'
  let arrowTop: number | undefined
  let arrowBottom: number | undefined
  if (rect) {
    const left = Math.max(
      VIEW_PAD,
      Math.min(window.innerWidth - bubbleW - RIGHT_PAD, rect.left + rect.width / 2 - bubbleW / 2)
    )
    const spaceBelow = window.innerHeight - rect.bottom - GAP
    const spaceAbove = rect.top - GAP
    const below = spaceBelow >= bubbleHeight || spaceBelow > spaceAbove
    const rawTop = below ? rect.bottom + GAP : rect.top - bubbleHeight - GAP
    const top = Math.max(8, Math.min(window.innerHeight - bubbleHeight - 8, rawTop))
    bubbleStyle = { position: 'fixed', left, top, width: bubbleW, boxSizing: 'border-box' }
    // 箭头：从气泡边缘指向目标中心（atan2 支持 45° 等任意角度）
    // ⬇ 默认朝下（0°），故角度 = deg - 90；用 deg + 90 会反 180°
    const bubbleCenterX = left + bubbleW / 2
    const bubbleCenterY = below ? top : top + bubbleHeight
    const targetCenterX = rect.left + rect.width / 2
    const targetCenterY = rect.top + rect.height / 2
    const deg = (Math.atan2(targetCenterY - bubbleCenterY, targetCenterX - bubbleCenterX) * 180) / Math.PI
    arrowAngle = deg - 90
    const arrowX = Math.max(40, Math.min(bubbleW - 40, targetCenterX - left))
    arrowLeft = `${arrowX}px`
    if (below) {
      arrowTop = -46
    } else {
      arrowBottom = -46
    }
  }

  return (
    <>
      {/* 截图（真实位置模拟）＋ 遮罩挖洞 */}
      {current.image && current.imageBox ? (
        <div
          style={{
            position: 'fixed',
            top: current.imageBox.top,
            ...(current.imageBox.right !== undefined
              ? { right: current.imageBox.right }
              : { left: current.imageBox.left ?? 0 }),
            zIndex: 2147482050,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2)',
            overflow: 'hidden',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
            background: '#fff',
          }}
        >
          <img
            data-tour-image
            src={current.image}
            alt={current.title}
            width={current.imageBox.width}
            height={current.imageBox.height}
            style={{
              display: 'block',
              width: current.imageBox.width,
              height: current.imageBox.height,
            }}
          />
        </div>
      ) : null}

      {/* 遮罩：在目标位置挖洞，四周压暗 */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 2147482000, pointerEvents: 'none' }}>
        {rect ? (
          <div
            style={{
              position: 'fixed',
              left: rect.left - 6,
              top: rect.top - 6,
              width: rect.width + 12,
              height: rect.height + 12,
              borderRadius: 10,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
            }}
          />
        ) : (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.55)' }} />
        )}
      </div>

      {/* 说明气泡 + 箭头 */}
      <div
        ref={bubbleRef}
        role="dialog"
        aria-label={current.title}
        style={{
          ...bubbleStyle,
          zIndex: 2147482100,
          padding: '16px 18px',
          borderRadius: 14,
          background: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base))',
          border: '1px solid var(--dsw-alias-border-l2)',
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.28)',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: arrowLeft,
            top: arrowTop,
            bottom: arrowBottom,
            transform: `translateX(-50%) rotate(${arrowAngle}deg)`,
            fontSize: 44,
            lineHeight: 1,
            color: 'var(--dsw-alias-brand-primary, #4d6bfe)',
            textShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
            pointerEvents: 'none',
          }}
        >
          ⬇
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
          {step + 1}. {current.title}
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.7,
            color: 'var(--dsw-alias-label-secondary, #6b7280)',
            whiteSpace: 'pre-line',
          }}
        >
          {current.desc}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a8f99)' }}>
            {step + 1} / {steps.length}
          </span>
          <button
            type="button"
            onClick={back}
            disabled={step === 0}
            style={{
              marginLeft: 'auto',
              padding: '6px 14px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              cursor: step === 0 ? 'default' : 'pointer',
              opacity: step === 0 ? 0.4 : 1,
            }}
          >
            上一步
          </button>
          <button
            type="button"
            onClick={finish}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            跳过
          </button>
          <button
            type="button"
            onClick={next}
            style={{
              padding: '6px 16px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
              color: '#fff',
              font: 'inherit',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {last ? '完成' : '下一步'}
          </button>
        </div>
      </div>
    </>
  )
}
