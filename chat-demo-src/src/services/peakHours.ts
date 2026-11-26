/**
 * DeepSeek 计费时段判断。
 *
 * 官方规则（DeepSeek API「Models & Pricing」，2026-11 核对）：
 *   高峰 = UTC 01:00-04:00 与 06:00-10:00，周一至周五，排除中国法定节假日；
 *   其余时段（含周末和法定节假日全天）为空闲，价格是高峰的一半。
 *   换算成北京时间（UTC+8）就是 09:00-12:00 与 14:00-18:00。
 *   https://api-docs.deepseek.com/quick_start/pricing
 *
 * 时区处理参考 DSH（deepseek-harness-desktop）的 packages/dsh-live-stats/src/pricing.ts：
 *   用 Intl.DateTimeFormat 固定按 Asia/Shanghai 取时间，而不是依赖运行机器的本地时区，
 *   这样海外用户或改了系统时区的用户也能算对。DSH 本身只判断时段，不处理周末与节假日，
 *   这里在它的基础上补齐了这两项。
 *
 * 节假日与调休依据：
 *   国务院办公厅《关于 2026 年部分节假日安排的通知》
 *   发文字号：国办发明电〔2025〕7 号
 *   成文日期：2025-11-04
 *   来源：https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 *   核对日期：2026-11-26
 */

/** 高峰时段（北京时间，左闭右开，单位：小时） */
const PEAK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [9, 12],
  [14, 18],
]

/**
 * 2026 年法定节假日（含调休放假），按国办发明电〔2025〕7 号原文逐条对应。
 * 该表每年需按国务院办公厅当年通知更新。
 */
const HOLIDAYS_2026: ReadonlySet<string> = new Set([
  // 一、元旦：1月1日（周四）至3日（周六）放假调休，共3天
  '2026-01-01',
  '2026-01-02',
  '2026-01-03',
  // 二、春节：2月15日（农历腊月二十八、周日）至23日（农历正月初七、周一）放假调休，共9天
  '2026-02-15',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-21',
  '2026-02-22',
  '2026-02-23',
  // 三、清明节：4月4日（周六）至6日（周一）放假，共3天
  '2026-04-04',
  '2026-04-05',
  '2026-04-06',
  // 四、劳动节：5月1日（周五）至5日（周二）放假调休，共5天
  '2026-05-01',
  '2026-05-02',
  '2026-05-03',
  '2026-05-04',
  '2026-05-05',
  // 五、端午节：6月19日（周五）至21日（周日）放假，共3天
  '2026-06-19',
  '2026-06-20',
  '2026-06-21',
  // 六、中秋节：9月25日（周五）至27日（周日）放假，共3天
  '2026-09-25',
  '2026-09-26',
  '2026-09-27',
  // 七、国庆节：10月1日（周四）至7日（周三）放假调休，共7天
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
])

/**
 * 2026 年调休上班日（落在周末但按工作日上班），按国办发明电〔2025〕7 号原文：
 *   元旦 1月4日（周日）、春节 2月14日（周六）与 2月28日（周六）、
 *   劳动节 5月9日（周六）、国庆 9月20日（周日）与 10月10日（周六）。
 */
const MAKEUP_WORKDAYS_2026: ReadonlySet<string> = new Set([
  '2026-01-04',
  '2026-02-14',
  '2026-02-28',
  '2026-05-09',
  '2026-09-20',
  '2026-10-10',
])

const EMPTY_SET: ReadonlySet<string> = new Set<string>()

/** 固定按北京时间取「日期 + 小时 + 星期」，避免依赖运行机器的本地时区。 */
const SHANGHAI_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
  weekday: 'short',
})

type ShanghaiClock = { dateKey: string; hour: number; weekend: boolean }

const shanghaiClock = (now: Date): ShanghaiClock => {
  const parts = SHANGHAI_FORMAT.formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const year = get('year')
  const month = get('month')
  const day = get('day')
  const hour = Number(get('hour')) % 24
  const weekday = get('weekday')
  return {
    dateKey: `${year}-${month}-${day}`,
    hour,
    weekend: weekday === 'Sat' || weekday === 'Sun',
  }
}

/** 节假日表：只有 2026 有数据，其他年份退化为只按周末判断。 */
const holidaysOf = (year: number): ReadonlySet<string> =>
  year === 2026 ? HOLIDAYS_2026 : EMPTY_SET

/** 调休上班日表：只有 2026 有数据。 */
const makeupWorkdaysOf = (year: number): ReadonlySet<string> =>
  year === 2026 ? MAKEUP_WORKDAYS_2026 : EMPTY_SET

/** 当前是否处于高峰计费时段（按北京时间，已排除周末与法定节假日，并包含调休上班日）。 */
export const isPeakNow = (now: Date): boolean => {
  const { dateKey, hour, weekend } = shanghaiClock(now)
  const year = Number(dateKey.slice(0, 4))
  // 法定节假日（含调休放假）一律空闲，即使落在工作日
  if (holidaysOf(year).has(dateKey)) return false
  // 周末补班要按工作日算
  if (weekend && !makeupWorkdaysOf(year).has(dateKey)) return false
  return PEAK_RANGES.some(([from, to]) => hour >= from && hour < to)
}
