/**
 * 打字背单词的词库。
 *
 * 词库内容是公开数据（词汇表本身没有著作权问题），词表自整理；
 * 玩法参考 qwerty-learner（GPL-3，代码一个字没搬，见 docs/迭代记录）。
 *
 * 选词标准：高频、常用、拼写有练习价值。每章 15 个词 —— 一章五分钟
 * 上下的练习量，"再来一章"的心理门槛最低。
 *
 * ipa 是美式宽式音标；coder 词库多为代码标识符（不是英文单词），
 * 音标留空，界面自行隐藏。
 */

export interface TypingWord {
  /** 单词本身。 */
  w: string
  /** 音标（可空，空则界面不显示）。 */
  ipa?: string
  /** 释义（一到两个常用义）。 */
  t: string
}

export interface TypingChapter {
  title: string
  words: TypingWord[]
}

export interface TypingDict {
  id: string
  name: string
  chapters: TypingChapter[]
}

const cet4: TypingDict = {
  id: 'cet4',
  name: 'CET-4 高频',
  chapters: [
    {
      title: '第 1 章 · 日常',
      words: [
        { w: 'morning', ipa: "'mɔːrnɪŋ", t: '早晨' },
        { w: 'evening', ipa: "'iːvnɪŋ", t: '傍晚' },
        { w: 'breakfast', ipa: "'brekfəst", t: '早餐' },
        { w: 'dinner', ipa: "'dɪnər", t: '晚餐' },
        { w: 'kitchen', ipa: "'kɪtʃɪn", t: '厨房' },
        { w: 'bedroom', ipa: "'bedruːm", t: '卧室' },
        { w: 'window', ipa: "'wɪndoʊ", t: '窗户' },
        { w: 'mirror', ipa: "'mɪrər", t: '镜子' },
        { w: 'towel', ipa: "'taʊəl", t: '毛巾' },
        { w: 'blanket', ipa: "'blæŋkɪt", t: '毯子' },
        { w: 'pillow', ipa: "'pɪloʊ", t: '枕头' },
        { w: 'basket', ipa: "'bæskɪt", t: '篮子' },
        { w: 'candle', ipa: "'kændl", t: '蜡烛' },
        { w: 'umbrella', ipa: "ʌm'brelə", t: '雨伞' },
        { w: 'wallet', ipa: "'wɑːlɪt", t: '钱包' },
      ],
    },
    {
      title: '第 2 章 · 校园',
      words: [
        { w: 'campus', ipa: "'kæmpəs", t: '校园' },
        { w: 'lecture', ipa: "'lektʃər", t: '讲座' },
        { w: 'library', ipa: "'laɪbreri", t: '图书馆' },
        { w: 'laboratory', ipa: "lə'bɔːrətɔːri", t: '实验室' },
        { w: 'semester', ipa: "sɪ'mestər", t: '学期' },
        { w: 'schedule', ipa: "'skedʒuːl", t: '日程表' },
        { w: 'assignment', ipa: "ə'saɪnmənt", t: '作业' },
        { w: 'examination', ipa: "ɪg,zæmɪ'neɪʃn", t: '考试' },
        { w: 'scholarship', ipa: "'skɑːlərʃɪp", t: '奖学金' },
        { w: 'graduation', ipa: ",grænʊ'eɪʃn", t: '毕业' },
        { w: 'professor', ipa: "prə'fesər", t: '教授' },
        { w: 'classmate', ipa: "'klæsmeɪt", t: '同学' },
        { w: 'notebook', ipa: "'noʊtbʊk", t: '笔记本' },
        { w: 'camp', ipa: "kæmp", t: '营地' },
        { w: 'dormitory', ipa: "'dɔːrmətɔːri", t: '宿舍' },
      ],
    },
    {
      title: '第 3 章 · 工作',
      words: [
        { w: 'meeting', ipa: "'miːtɪŋ", t: '会议' },
        { w: 'office', ipa: "'ɔːfɪs", t: '办公室' },
        { w: 'colleague', ipa: "'kɑːliːg", t: '同事' },
        { w: 'manager', ipa: "'mænɪdʒər", t: '经理' },
        { w: 'salary', ipa: "'sæləri", t: '工资' },
        { w: 'interview', ipa: "'ɪntərvjuː", t: '面试' },
        { w: 'resume', ipa: "'rezjʊmeɪ", t: '简历' },
        { w: 'deadline', ipa: "'dedlaɪn", t: '截止日期' },
        { w: 'overtime', ipa: "'oʊvərtaɪm", t: '加班' },
        { w: 'promotion', ipa: "prə'moʊʃn", t: '晋升' },
        { w: 'retirement', ipa: "rɪ'taɪərmənt", t: '退休' },
        { w: 'business', ipa: "'bɪznɪs", t: '生意' },
        { w: 'customer', ipa: "'kʌstəmər", t: '顾客' },
        { w: 'contract', ipa: "'kɑːntrækt", t: '合同' },
        { w: 'company', ipa: "'kʌmpəni", t: '公司' },
      ],
    },
    {
      title: '第 4 章 · 出行',
      words: [
        { w: 'airport', ipa: "'erpɔːrt", t: '机场' },
        { w: 'passport', ipa: "'pæspɔːrt", t: '护照' },
        { w: 'luggage', ipa: "'lʌgɪdʒ", t: '行李' },
        { w: 'subway', ipa: "'sʌbweɪ", t: '地铁' },
        { w: 'highway', ipa: "'haɪweɪ", t: '公路' },
        { w: 'traffic', ipa: "'træfɪk", t: '交通' },
        { w: 'journey', ipa: "'dʒɜːrni", t: '旅程' },
        { w: 'tourist', ipa: "'tʊrɪst", t: '游客' },
        { w: 'hotel', ipa: "hoʊ'tel", t: '旅馆' },
        { w: 'reservation', ipa: ",rezər'veɪʃn", t: '预订' },
        { w: 'abroad', ipa: "ə'brɔːd", t: '国外' },
        { w: 'customs', ipa: "'kʌstəmz", t: '海关' },
        { w: 'station', ipa: "'steɪʃn", t: '车站' },
        { w: 'bicycle', ipa: "'baɪsɪkl", t: '自行车' },
        { w: 'driver', ipa: "'draɪvər", t: '司机' },
      ],
    },
    {
      title: '第 5 章 · 情感',
      words: [
        { w: 'happiness', ipa: "'hæpinɪs", t: '幸福' },
        { w: 'lonely', ipa: "'loʊnli", t: '孤独的' },
        { w: 'curious', ipa: "'kjʊriəs", t: '好奇的' },
        { w: 'nervous', ipa: "'nɜːrvəs", t: '紧张的' },
        { w: 'confident', ipa: "'kɑːnfɪdənt", t: '自信的' },
        { w: 'grateful', ipa: "'greɪtfl", t: '感激的' },
        { w: 'jealous', ipa: "'dʒeləs", t: '嫉妒的' },
        { w: 'proud', ipa: "praʊd", t: '自豪的' },
        { w: 'ashamed', ipa: "ə'ʃeɪmd", t: '羞愧的' },
        { w: 'excited', ipa: "ɪk'saɪtɪd", t: '兴奋的' },
        { w: 'bored', ipa: "bɔːrd", t: '无聊的' },
        { w: 'anxious', ipa: "'æŋkʃəs", t: '焦虑的' },
        { w: 'satisfied', ipa: "'sætɪsfaɪd", t: '满意的' },
        { w: 'disappointed', ipa: ",dɪsə'pɔɪntɪd", t: '失望的' },
        { w: 'sympathy', ipa: "'sɪmpəθi", t: '同情' },
      ],
    },
    {
      title: '第 6 章 · 社会与抽象',
      words: [
        { w: 'government', ipa: "'gʌvərnmənt", t: '政府' },
        { w: 'society', ipa: "sə'saɪəti", t: '社会' },
        { w: 'economy', ipa: "ɪ'kɑːnəmi", t: '经济' },
        { w: 'environment', ipa: "ɪn'vaɪrənmənt", t: '环境' },
        { w: 'population', ipa: ",pɑːpju'leɪʃn", t: '人口' },
        { w: 'technology', ipa: "tek'nɑːlədʒi", t: '技术' },
        { w: 'education', ipa: ",edʒu'keɪʃn", t: '教育' },
        { w: 'culture', ipa: "'kʌltʃər", t: '文化' },
        { w: 'influence', ipa: "'ɪnflʊəns", t: '影响' },
        { w: 'opportunity', ipa: ",ɑːpər'tuːnəti", t: '机会' },
        { w: 'responsibility', ipa: "rɪ,spɑːnsə'bɪləti", t: '责任' },
        { w: 'independence', ipa: ",ɪndɪ'pendəns", t: '独立' },
        { w: 'communication', ipa: "kə,mjuːnɪ'keɪʃn", t: '交流' },
        { w: 'experience', ipa: "ɪk'spɪriəns", t: '经验' },
        { w: 'attitude', ipa: "'ætɪtuːd", t: '态度' },
      ],
    },
  ],
}

const cet6: TypingDict = {
  id: 'cet6',
  name: 'CET-6 高频',
  chapters: [
    {
      title: '第 1 章 · 动词',
      words: [
        { w: 'abolish', ipa: "ə'bɑːlɪʃ", t: '废除' },
        { w: 'accelerate', ipa: "ək'seləreɪt", t: '加速' },
        { w: 'accommodate', ipa: "ə'kɑːmədeɪt", t: '容纳' },
        { w: 'accumulate', ipa: "ə'kjuːmjəleɪt", t: '积累' },
        { w: 'acknowledge', ipa: "ək'nɑːlɪdʒ", t: '承认' },
        { w: 'advocate', ipa: "'ædvəkeɪt", t: '提倡' },
        { w: 'alleviate', ipa: "ə'liːvieɪt", t: '减轻' },
        { w: 'anticipate', ipa: "æn'tɪsɪpeɪt", t: '预期' },
        { w: 'compensate', ipa: "'kɑːmpenseɪt", t: '补偿' },
        { w: 'deteriorate', ipa: "dɪ'tɪriəreɪt", t: '恶化' },
        { w: 'discriminate', ipa: "dɪ'skrɪmɪneɪt", t: '歧视' },
        { w: 'eliminate', ipa: "ɪ'lɪmɪneɪt", t: '消除' },
        { w: 'facilitate', ipa: "fə'sɪlɪteɪt", t: '促进' },
        { w: 'manipulate', ipa: "mə'nɪpjʊleɪt", t: '操纵' },
        { w: 'underestimate', ipa: ",ʌndər'estɪmeɪt", t: '低估' },
      ],
    },
    {
      title: '第 2 章 · 名词',
      words: [
        { w: 'ambiguity', ipa: ",æmbɪ'gjuːəti", t: '歧义' },
        { w: 'apparatus', ipa: ",æpə'rætəs", t: '设备' },
        { w: 'bureaucracy', ipa: "bjʊ'rɑːkrəsi", t: '官僚机构' },
        { w: 'criterion', ipa: "kraɪ'tɪriən", t: '标准' },
        { w: 'dilemma', ipa: "dɪ'lemə", t: '困境' },
        { w: 'hierarchy', ipa: "'haɪərɑːrki", t: '等级制度' },
        { w: 'hypothesis', ipa: "haɪ'pɑːθəsɪs", t: '假设' },
        { w: 'phenomenon', ipa: "fə'nɑːmɪnən", t: '现象' },
        { w: 'paradox', ipa: "'pærədɑːks", t: '悖论' },
        { w: 'perspective', ipa: "pər'spektɪv", t: '视角' },
        { w: 'priority', ipa: "praɪ'ɔːrəti", t: '优先级' },
        { w: 'resistance', ipa: "rɪ'zɪstəns", t: '抵抗' },
        { w: 'spectrum', ipa: "'spektrəm", t: '光谱' },
        { w: 'threshold', ipa: "'θreʃhoʊld", t: '门槛' },
        { w: 'velocity', ipa: "və'lɑːsəti", t: '速度' },
      ],
    },
    {
      title: '第 3 章 · 形容词',
      words: [
        { w: 'abundant', ipa: "ə'bʌndənt", t: '丰富的' },
        { w: 'compatible', ipa: "kəm'pætəbl", t: '兼容的' },
        { w: 'comprehensive', ipa: ",kɑːmprɪ'hensɪv", t: '全面的' },
        { w: 'controversial', ipa: ",kɑːntrə'vɜːrʃl", t: '有争议的' },
        { w: 'crucial', ipa: "'kruːʃl", t: '关键的' },
        { w: 'delicate', ipa: "'delɪkət", t: '脆弱的' },
        { w: 'explicit', ipa: "ɪk'splɪsɪt", t: '明确的' },
        { w: 'inevitable', ipa: "ɪn'evɪtəbl", t: '不可避免的' },
        { w: 'legitimate', ipa: "lɪ'dʒɪtɪmət", t: '合法的' },
        { w: 'notorious', ipa: "noʊ'tɔːriəs", t: '臭名昭著的' },
        { w: 'prevailing', ipa: "prɪ'veɪlɪŋ", t: '盛行的' },
        { w: 'profound', ipa: "prə'faʊnd", t: '深刻的' },
        { w: 'redundant', ipa: "rɪ'dʌndənt", t: '多余的' },
        { w: 'skeptical', ipa: "'skeptɪkl", t: '怀疑的' },
        { w: 'vulnerable', ipa: "'vʌlnərəbl", t: '易受伤的' },
      ],
    },
    {
      title: '第 4 章 · 学术',
      words: [
        { w: 'empirical', ipa: "ɪm'pɪrɪkl", t: '经验主义的' },
        { w: 'methodology', ipa: ",meθə'dɑːlədʒi", t: '方法论' },
        { w: 'deduction', ipa: "dɪ'dʌkʃn", t: '演绎' },
        { w: 'inference', ipa: "'ɪnfərəns", t: '推理' },
        { w: 'correlation', ipa: ",kɔːrə'leɪʃn", t: '相关性' },
        { w: 'variable', ipa: "'veriəbl", t: '变量' },
        { w: 'mechanism', ipa: "'mekənɪzəm", t: '机制' },
        { w: 'framework', ipa: "'freɪmwɜːrk", t: '框架' },
        { w: 'paradigm', ipa: "'pærədaɪm", t: '范式' },
        { w: 'empower', ipa: "ɪm'paʊər", t: '赋能' },
        { w: 'implement', ipa: "'ɪmplɪment", t: '实施' },
        { w: 'derive', ipa: "dɪ'raɪv", t: '推导' },
        { w: 'attribute', ipa: "'ætrɪbjuːt", t: '归因于' },
        { w: 'constraint', ipa: "kən'streɪnt", t: '约束' },
        { w: 'consensus', ipa: "kən'sensəs", t: '共识' },
      ],
    },
  ],
}

const kaoyan: TypingDict = {
  id: 'kaoyan',
  name: '考研英语',
  chapters: [
    {
      title: '第 1 章 · 阅读高频',
      words: [
        { w: 'abstract', ipa: "'æbstrækt", t: '抽象的' },
        { w: 'academic', ipa: ",ækə'demɪk", t: '学术的' },
        { w: 'access', ipa: "'ækses", t: '获取' },
        { w: 'account', ipa: "ə'kaʊnt", t: '解释' },
        { w: 'achieve', ipa: "ə'tʃiːv", t: '达成' },
        { w: 'acquire', ipa: "ə'kwaɪər", t: '获得' },
        { w: 'adapt', ipa: "ə'dæpt", t: '适应' },
        { w: 'adequate', ipa: "'ædɪkwət", t: '足够的' },
        { w: 'adjust', ipa: "ə'dʒʌst", t: '调整' },
        { w: 'appropriate', ipa: "ə'proʊpriət", t: '恰当的' },
        { w: 'approve', ipa: "ə'pruːv", t: '批准' },
        { w: 'argue', ipa: "'ɑːrgjuː", t: '主张' },
        { w: 'assess', ipa: "ə'ses", t: '评估' },
        { w: 'assume', ipa: "ə'suːm", t: '假定' },
        { w: 'authority', ipa: "ə'θɔːrəti", t: '权威' },
      ],
    },
    {
      title: '第 2 章 · 阅读高频',
      words: [
        { w: 'available', ipa: "ə'veɪləbl", t: '可获得的' },
        { w: 'aware', ipa: "ə'wer", t: '意识到的' },
        { w: 'campaign', ipa: "kæm'peɪn", t: '运动' },
        { w: 'capable', ipa: "'keɪpəbl", t: '有能力的' },
        { w: 'circumstance', ipa: "'sɜːrkəmstæns", t: '情况' },
        { w: 'colleague', ipa: "'kɑːliːg", t: '同事' },
        { w: 'comment', ipa: "'kɑːment", t: '评论' },
        { w: 'commitment', ipa: "kə'mɪtmənt", t: '承诺' },
        { w: 'community', ipa: "kə'mjuːnəti", t: '社区' },
        { w: 'compete', ipa: "kəm'piːt", t: '竞争' },
        { w: 'complaint', ipa: "kəm'pleɪnt", t: '抱怨' },
        { w: 'concern', ipa: "kən'sɜːrn", t: '关切' },
        { w: 'conduct', ipa: "kən'dʌkt", t: '进行' },
        { w: 'conflict', ipa: "'kɑːnflɪkt", t: '冲突' },
        { w: 'consequence', ipa: "'kɑːnsɪkwens", t: '后果' },
      ],
    },
    {
      title: '第 3 章 · 翻译难词',
      words: [
        { w: 'convention', ipa: "kən'venʃn", t: '惯例' },
        { w: 'conviction', ipa: "kən'vɪkʃn", t: '坚定的信念' },
        { w: 'correspond', ipa: ",kɔːrə'spɑːnd", t: '对应' },
        { w: 'decline', ipa: "dɪ'klaɪn", t: '衰退' },
        { w: 'dedicate', ipa: "'dedɪkeɪt", t: '奉献' },
        { w: 'distinguish', ipa: "dɪ'stɪŋgwɪʃ", t: '区分' },
        { w: 'diverse', ipa: "daɪ'vɜːrs", t: '多样的' },
        { w: 'domestic', ipa: "də'mestɪk", t: '国内的' },
        { w: 'emerge', ipa: "ɪ'mɜːrdʒ", t: '涌现' },
        { w: 'enormous', ipa: "ɪ'nɔːrməs", t: '巨大的' },
        { w: 'establish', ipa: "ɪ'stæblɪʃ", t: '确立' },
        { w: 'evident', ipa: "'evɪdənt", t: '明显的' },
        { w: 'excessive', ipa: "ɪk'sesɪv", t: '过度的' },
        { w: 'exert', ipa: "ɪg'zɜːrt", t: '施加' },
        { w: 'subordinate', ipa: "sə'bɔːrdɪnət", t: '从属的' },
      ],
    },
    {
      title: '第 4 章 · 写作加分',
      words: [
        { w: 'facilitate', ipa: "fə'sɪlɪteɪt", t: '促进' },
        { w: 'fundamental', ipa: ",fʌndə'mentl", t: '根本的' },
        { w: 'genuine', ipa: "'dʒenjuɪn", t: '真诚的' },
        { w: 'guarantee', ipa: ",gærən'tiː", t: '保证' },
        { w: 'highlight', ipa: "'haɪlaɪt", t: '强调' },
        { w: 'identical', ipa: "aɪ'dentɪkl", t: '完全相同的' },
        { w: 'immense', ipa: "ɪ'mens", t: '极大的' },
        { w: 'imply', ipa: "ɪm'plaɪ", t: '暗示' },
        { w: 'indispensable', ipa: ",ɪndɪ'spensəbl", t: '不可或缺的' },
        { w: 'initiative', ipa: "ɪ'nɪʃətɪv", t: '倡议' },
        { w: 'insight', ipa: "'ɪnsaɪt", t: '洞察' },
        { w: 'integral', ipa: "'ɪntɪgrəl", t: '构成整体所必需的' },
        { w: 'magnificent', ipa: "mæg'nɪfɪsnt", t: '壮丽的' },
        { w: 'overwhelming', ipa: ",oʊvər'welmɪŋ", t: '压倒性的' },
        { w: 'tremendous', ipa: "trə'mendəs", t: '巨大的' },
      ],
    },
  ],
}

const coder: TypingDict = {
  id: 'coder',
  name: '程序员 · API 与常用词',
  chapters: [
    {
      title: '第 1 章 · Web API',
      words: [
        { w: 'querySelector', t: '查找 DOM 元素' },
        { w: 'addEventListener', t: '绑定事件监听' },
        { w: 'getElementById', t: '按 id 取元素' },
        { w: 'appendChild', t: '追加子节点' },
        { w: 'removeChild', t: '移除子节点' },
        { w: 'setTimeout', t: '延时执行' },
        { w: 'setInterval', t: '定时循环执行' },
        { w: 'clearTimeout', t: '取消延时' },
        { w: 'preventDefault', t: '阻止默认行为' },
        { w: 'stopPropagation', t: '阻止事件冒泡' },
        { w: 'localStorage', t: '本地存储' },
        { w: 'sessionStorage', t: '会话存储' },
        { w: 'encodeURIComponent', t: 'URL 编码' },
        { w: 'requestAnimationFrame', t: '下一帧回调' },
        { w: 'IntersectionObserver', t: '交叉观察器' },
      ],
    },
    {
      title: '第 2 章 · JavaScript 关键字',
      words: [
        { w: 'function', t: '函数' },
        { w: 'return', t: '返回' },
        { w: 'undefined', t: '未定义' },
        { w: 'prototype', t: '原型' },
        { w: 'constructor', t: '构造器' },
        { w: 'instanceof', t: '类型判断' },
        { w: 'typeof', t: '取类型' },
        { w: 'async', t: '异步' },
        { w: 'await', t: '等待' },
        { w: 'yield', t: '产出' },
        { w: 'extends', t: '继承' },
        { w: 'implements', t: '实现' },
        { w: 'interface', t: '接口' },
        { w: 'namespace', t: '命名空间' },
        { w: 'deprecated', t: '已弃用的' },
      ],
    },
    {
      title: '第 3 章 · 后端与网络',
      words: [
        { w: 'middleware', t: '中间件' },
        { w: 'callback', t: '回调' },
        { w: 'websocket', t: '长连接协议' },
        { w: 'localhost', t: '本机地址' },
        { w: 'endpoint', t: '接口地址' },
        { w: 'payload', t: '请求体' },
        { w: 'handshake', t: '握手' },
        { w: 'timestamp', t: '时间戳' },
        { w: 'serialize', t: '序列化' },
        { w: 'deserialize', t: '反序列化' },
        { w: 'authenticate', t: '身份验证' },
        { w: 'authorization', t: '鉴权' },
        { w: 'throughput', t: '吞吐量' },
        { w: 'concurrency', t: '并发' },
        { w: 'backpressure', t: '背压' },
      ],
    },
    {
      title: '第 4 章 · 数据库与工程',
      words: [
        { w: 'transaction', t: '事务' },
        { w: 'rollback', t: '回滚' },
        { w: 'migration', t: '迁移' },
        { w: 'schema', t: '模式' },
        { w: 'constraint', t: '约束' },
        { w: 'index', t: '索引' },
        { w: 'cache', t: '缓存' },
        { w: 'checkpoint', t: '检查点' },
        { w: 'replication', t: '主从复制' },
        { w: 'sharding', t: '分片' },
        { w: 'idempotent', t: '幂等的' },
        { w: 'consistency', t: '一致性' },
        { w: 'deployment', t: '部署' },
        { w: 'observability', t: '可观测性' },
        { w: 'benchmark', t: '基准测试' },
      ],
    },
  ],
}

export const TYPING_DICTS: TypingDict[] = [cet4, cet6, kaoyan, coder]
