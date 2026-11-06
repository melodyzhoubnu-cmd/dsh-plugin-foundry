/**
 * Demo world: publishers, a format-1 catalog and the entries the scenarios
 * exercise. Keys are generated per run, so the demo never ships private keys.
 */
import { exportPublicKey, generateIdentity, keyFingerprint, sha256Hex } from '../protocol/canonical.js'

const CAPABILITY_TITLES = {
  'spreadsheet.read': '读取表格',
  'spreadsheet.write': '写入表格',
  'chart.create': '生成图表',
  'table.transform': '表格转换',
  'doc.write': '撰写文档',
  'doc.read': '读取文档',
  'doc.format': '排版',
  'pdf.extract': '提取 PDF',
  'slide.create': '生成幻灯片',
  'test.run': '运行测试',
  'log.inspect': '分析日志',
  'error.explain': '解释报错',
  'code.edit': '编辑代码',
  'code.review': '代码评审',
  'git.diff': '查看 diff',
  'web.search': '网页搜索',
  'web.fetch': '抓取网页',
  'data.query': '查询数据',
  'dataframe.run': '运行数据框',
  'memory.store': '存储记忆',
  'session.archive': '归档会话',
  'notify.send': '发送通知',
  'webhook.trigger': '触发 webhook',
}

function makePublisher(name, label) {
  const identity = generateIdentity()
  return {
    name,
    label,
    id: keyFingerprint(identity.publicKey),
    privateKey: identity.privateKey,
    publicKey: identity.publicKey,
    publicKeyB64: exportPublicKey(identity.publicKey),
    publicPem: identity.publicPem,
  }
}

function daysAgo(days) {
  return Math.floor((Date.now() - days * 86400000) / 1000)
}

function makeEntry({
  name,
  title,
  description,
  category,
  keywords,
  capabilities,
  tools = [],
  quality,
  risk = {},
  publisher,
  versions = 3,
  lastPublishedDaysAgo = 3,
  engines = '>=0.2.1',
  sourceType = 'npm',
  installSpec = '',
}) {
  const version = `1.${versions}.0`
  return {
    name,
    title: { zh: title, en: title },
    description: { zh: description, en: description },
    metadata: {
      category,
      keywords,
      labels: [],
      capabilities: capabilities.map((id) => ({ id, title: CAPABILITY_TITLES[id] || id })),
      tools,
      quality,
      risk: {
        postinstall: false,
        restartRequired: false,
        dataEgress: false,
        permissions: [],
        ...risk,
      },
      ...(installSpec ? { installSpec } : {}),
      publisher: {
        id: publisher.id,
        publicKey: publisher.publicKeyB64,
        name: publisher.label,
        verified: true,
      },
    },
    versions: [
      {
        version,
        publishTimestamp: daysAgo(lastPublishedDaysAgo),
        source: sourceType === 'git' ? { type: 'git', url: installSpec } : { type: 'npm' },
        engines: { dsh: engines },
        integrity: sha256Hex(`${name}@${version}`),
      },
      ...Array.from({ length: Math.max(0, versions - 1) }, (_, index) => ({
        version: `1.${versions - 1 - index}.0`,
        publishTimestamp: daysAgo(lastPublishedDaysAgo + (index + 1) * 21),
        source: sourceType === 'git' ? { type: 'git', url: installSpec } : { type: 'npm' },
        engines: { dsh: engines },
        integrity: sha256Hex(`${name}@1.${versions - 1 - index}.0`),
      })),
    ],
  }
}

export function buildDemoSeed() {
  const excelLabs = makePublisher('excel-labs', 'Excel Labs')
  const chartify = makePublisher('chartify', 'Chartify')
  const docsmith = makePublisher('docsmith', 'Docsmith')
  const debugLabs = makePublisher('debug-labs', 'Debug Labs')
  const webCo = makePublisher('web-co', 'Web Co')
  const printShop = makePublisher('xiangkou-print', '巷口打印')
  const formLab = makePublisher('formlab', 'FormLab')
  const deepseek = makePublisher('deepseek', 'DeepSeek')
  const toybox = makePublisher('toybox', 'Toybox')
  const risky = makePublisher('risky-labs', 'Risky Labs')

  const publishers = [excelLabs, chartify, docsmith, debugLabs, webCo, deepseek, toybox, risky]
  const publisherByPlugin = {}

  const plugins = [
    makeEntry({
      name: 'dsh-excel-chat',
      title: 'Excel 对话助手',
      description: '直接读写 xlsx，支持公式、数据透视和折线图；能按月份聚合销售表并输出图表与结论。',
      category: 'docs',
      keywords: ['xlsx', 'excel', '表格', '报表', '折线图', '图表', '公式', '数据透视'],
      capabilities: ['spreadsheet.read', 'spreadsheet.write', 'chart.create', 'table.transform'],
      tools: ['excel_read', 'excel_write', 'excel_operate', 'excel_create_chart', 'excel_profile'],
      quality: { score: 0.86, verified: true, curated: true, users: 12800, stars: 420 },
      publisher: excelLabs,
      versions: 4,
      lastPublishedDaysAgo: 1,
    }),
    makeEntry({
      name: 'dsh-chart-suite',
      title: '图表工坊',
      description: '把 CSV / JSON 数据变成可编辑图表，支持配色、导出 PNG 与 SVG。',
      category: 'tools',
      keywords: ['图表', 'chart', '折线图', '可视化', 'csv'],
      capabilities: ['chart.create', 'data.query'],
      tools: ['chart_create', 'chart_export'],
      quality: { score: 0.64, verified: true, curated: false, users: 5400, stars: 120 },
      publisher: chartify,
      versions: 2,
      lastPublishedDaysAgo: 20,
    }),
    makeEntry({
      name: 'dsh-report-writer',
      title: '报告撰写',
      description: '把要点扩写成结构化报告，支持标题层级、目录、引用和 docx 导出。',
      category: 'docs',
      keywords: ['报告', 'docx', '写作', '排版', '结论'],
      capabilities: ['doc.write', 'doc.format'],
      tools: ['report_write', 'report_export'],
      quality: { score: 0.71, verified: true, curated: true, users: 7300, stars: 210 },
      publisher: docsmith,
      versions: 3,
      lastPublishedDaysAgo: 8,
    }),
    makeEntry({
      name: 'dsh-pytest-doctor',
      title: 'Pytest 医生',
      description: '聚合 pytest 失败用例、定位最后一个改动点，并给出可复现命令。',
      category: 'dev',
      keywords: ['pytest', '测试', '报错', '失败', '调试'],
      capabilities: ['test.run', 'error.explain', 'log.inspect'],
      tools: ['pytest_run', 'pytest_explain'],
      quality: { score: 0.78, verified: true, curated: true, users: 3100, stars: 260 },
      publisher: debugLabs,
      versions: 3,
      lastPublishedDaysAgo: 5,
    }),
    makeEntry({
      name: 'dsh-log-lens',
      title: '日志放大镜',
      description: '把长日志压成时间线与异常簇，支持 grep 回跳与上下文窗口。',
      category: 'dev',
      keywords: ['日志', 'log', '异常', '排错'],
      capabilities: ['log.inspect'],
      tools: ['log_scan'],
      quality: { score: 0.61, verified: false, curated: false, users: 1800, stars: 70 },
      publisher: debugLabs,
      versions: 2,
      lastPublishedDaysAgo: 40,
    }),
    makeEntry({
      name: 'dsh-web-researcher',
      title: '调研助手',
      description: '并行检索多个来源、去重、标注出处，并把结果整理成可引用的简报。',
      category: 'browser',
      keywords: ['调研', '搜索', '资料', 'citation', '竞品'],
      capabilities: ['web.search', 'web.fetch', 'doc.write'],
      tools: ['research_web', 'research_brief'],
      quality: { score: 0.72, verified: true, curated: false, users: 4600, stars: 180 },
      publisher: webCo,
      versions: 3,
      lastPublishedDaysAgo: 12,
    }),
    makeEntry({
      name: 'dsh-slide-forge',
      title: '幻灯片锻造',
      description: '从大纲直接生成可编辑的pptx，自动套用版式并生成图表页。',
      category: 'docs',
      keywords: ['pptx', '幻灯片', '演示', '汇报'],
      capabilities: ['slide.create', 'chart.create'],
      tools: ['slide_create'],
      quality: { score: 0.67, verified: false, curated: false, users: 2200, stars: 95 },
      publisher: docsmith,
      versions: 2,
      lastPublishedDaysAgo: 30,
    }),
    makeEntry({
      name: 'dsh-gltf-exporter',
      title: 'glTF 导出器',
      description: '把 three.js / Blender 场景导出为 glTF 或 GLB，校验材质、贴图与动画轨道。',
      category: 'tools',
      keywords: ['gltf', 'glb', 'three.js', '3d', '导出', '模型'],
      capabilities: ['model.export'],
      tools: ['gltf_export'],
      quality: { score: 0.62, verified: false, curated: false, users: 80, stars: 24 },
      publisher: toybox,
      versions: 1,
      lastPublishedDaysAgo: 10,
      sourceType: 'git',
      installSpec: 'https://github.com/example/dsh-gltf-exporter',
    }),
    makeEntry({
      name: 'dsh-theme-pack',
      title: '配色主题包',
      description: '一组明暗主题与等宽字体搭配。',
      category: 'theme',
      keywords: ['主题', '配色', 'dark'],
      capabilities: [],
      tools: [],
      quality: { score: 0.5, verified: false, curated: false, users: 900, stars: 30 },
      publisher: toybox,
      versions: 2,
      lastPublishedDaysAgo: 15,
    }),
    makeEntry({
      name: '@deepseek-ai/dsh-sheet',
      title: '官方表格',
      description: '官方维护的表格读取与基础编辑能力。',
      category: 'docs',
      keywords: ['xlsx', '表格', 'sheet'],
      capabilities: ['spreadsheet.read'],
      tools: ['sheet_read'],
      quality: { score: 0.8, verified: true, curated: true, users: 21000, stars: 0 },
      publisher: deepseek,
      versions: 3,
      lastPublishedDaysAgo: 2,
    }),
    makeEntry({
      name: 'dsh-future-plugin',
      title: '未来表格插件',
      description: '需要 DSH 0.3 的表格与图表能力，当前版本不兼容。',
      category: 'docs',
      keywords: ['xlsx', '表格', '图表'],
      capabilities: ['spreadsheet.read', 'chart.create'],
      tools: ['future_excel'],
      quality: { score: 0.7, verified: false, curated: false, users: 200, stars: 10 },
      publisher: toybox,
      versions: 1,
      lastPublishedDaysAgo: 1,
      engines: '>=0.3.0',
    }),
    makeEntry({
      name: 'dsh-risky-installer',
      title: '表格增强（有安装脚本）',
      description: '增强 xlsx 公式与图表，但安装时会运行 postinstall 脚本。',
      category: 'docs',
      keywords: ['xlsx', 'excel', '表格', '图表'],
      capabilities: ['spreadsheet.read', 'chart.create'],
      tools: ['risky_excel'],
      quality: { score: 0.7, verified: false, curated: false, users: 1500, stars: 60 },
      risk: { postinstall: true, permissions: ['network', 'filesystem'] },
      publisher: risky,
      versions: 2,
      lastPublishedDaysAgo: 4,
    }),
    makeEntry({
      name: 'dsh-already-installed',
      title: '已装的表格插件',
      description: '已经装过的表格插件，不应再被推荐或安装。',
      category: 'docs',
      keywords: ['xlsx', 'excel', '表格'],
      capabilities: ['spreadsheet.read'],
      tools: ['installed_excel'],
      quality: { score: 0.8, verified: true, curated: false, users: 900, stars: 40 },
      publisher: toybox,
      versions: 2,
      lastPublishedDaysAgo: 2,
    }),
    makeEntry({
      name: 'dsh-generic-chart',
      title: '通用图表',
      description: '任意数据的通用图表组件，功能泛化，没有表格感知。',
      category: 'tools',
      keywords: ['图表', 'chart'],
      capabilities: ['chart.create'],
      tools: ['generic_chart'],
      quality: { score: 0.4, verified: false, curated: false, users: 300, stars: 5 },
      publisher: toybox,
      versions: 1,
      lastPublishedDaysAgo: 200,
    }),
  ]

  for (const plugin of plugins) {
    const publisher = publishers.find((item) => item.id === plugin.metadata.publisher.id)
    if (publisher) publisherByPlugin[plugin.name] = publisher
  }

  const catalog = {
    format: 1,
    title: { zh: 'Plugin Foundry 演示目录', en: 'Plugin Foundry demo catalog' },
    description: { zh: '用于演示分发、计量与结算的 format-1 目录。', en: 'A format-1 catalog for the distribution, metering and settlement demo.' },
    metadata: { categories: {}, labels: {}, sortKeys: {} },
    plugins,
  }

  return { catalog, publishers, publisherByPlugin }
}
