# ASR A/B 试验报告：DeepSeek vs Azure / 智谱 GLM-ASR（task-112）

- 生成时间：2026-11-14T06:00:52+00:00
- 样本：英文 20 条 / 中文 20 条（**Azure TTS 合成清晰语音**，已知参考文本）
- CER：中文按字（编辑距离/参考字数），英文按词（编辑距离/参考词数）；标点与空格已归一化
- 成本：DeepSeek ¥0.78/小时、Azure ¥7.2/小时、智谱 ¥3.6/小时（=¥0.06/分钟），仅估算
- **局限**：合成语音 ≠ 儿童真实语音；未覆盖口音、噪声、语速、数字/标点、中英混说、长音频切段等场景

> 注意：本机无智谱 key，中文对照列（智谱）**未执行**（不伪造结果）。

## 汇总

| 语言 | Provider | 条数 | CER 均值 | CER 中位数 | 平均延迟(ms) | 估算成本(元) |
|---|---|---|---|---|---|---|
| en | deepseek | 20 | 0.007 | 0.000 | 755 | 0.0089 |
| en | azure | 20 | 0.043 | 0.000 | 1892 | 0.0821 |
| zh | deepseek | 20 | 0.015 | 0.000 | 810 | 0.0100 |

## 逐条结果

| # | 语言 | 参考文本 | DeepSeek（CER/ms） | 识别结果 | 对照 provider（CER/ms） |
|---|---|---|---|---|---|
| 1 | en | I like going to my school today. | 0.000 / 835ms | I like going to my school today. | azure: 0.000 / 1439ms |
| 2 | en | My teacher reads a story to us every morni | 0.000 / 687ms | My teacher reads a story to us every morning. | azure: 0.000 / 1896ms |
| 3 | en | The cat is sleeping under the chair. | 0.000 / 716ms | The cat is sleeping under the chair. | azure: 0.000 / 1509ms |
| 4 | en | I would like a glass of water, please. | 0.000 / 689ms | I would like a glass of water, please. | azure: 0.000 / 1451ms |
| 5 | en | We played football in the park yesterday. | 0.000 / 739ms | We played football in the park yesterday. | azure: 0.000 / 1252ms |
| 6 | en | She is wearing a blue jacket and white sho | 0.000 / 797ms | She is wearing a blue jacket and white shoes. | azure: 0.000 / 1918ms |
| 7 | en | Can you help me carry this box upstairs? | 0.000 / 780ms | Can you help me carry this box upstairs? | azure: 0.000 / 1818ms |
| 8 | en | My favourite food is noodles with vegetabl | 0.143 / 780ms | My favorite food is noodles with vegetables. | azure: 0.143 / 2416ms |
| 9 | en | The train leaves at half past eight. | 0.000 / 712ms | The train leaves at half past eight. | azure: 0.429 / 2260ms |
| 10 | en | Please open the window, it is very hot tod | 0.000 / 749ms | Please open the window. It is very hot today. | azure: 0.000 / 1935ms |
| 11 | en | I have two brothers and one little sister. | 0.000 / 778ms | I have two brothers and one little sister. | azure: 0.000 / 1550ms |
| 12 | en | He bought a new bicycle last weekend. | 0.000 / 751ms | He bought a new bicycle last weekend. | azure: 0.000 / 1145ms |
| 13 | en | Do you want to come to the library with me | 0.000 / 754ms | Do you want to come to the library with me? | azure: 0.000 / 2090ms |
| 14 | en | The weather is sunny and warm this afterno | 0.000 / 718ms | The weather is sunny and warm this afternoon. | azure: 0.000 / 1172ms |
| 15 | en | I am learning English songs at school. | 0.000 / 722ms | I am learning English songs at school. | azure: 0.000 / 1271ms |
| 16 | en | There are many beautiful flowers in the ga | 0.000 / 766ms | There are many beautiful flowers in the garden. | azure: 0.000 / 1576ms |
| 17 | en | Would you like some tea or coffee? | 0.000 / 723ms | Would you like some tea or coffee? | azure: 0.000 / 1750ms |
| 18 | en | My mother cooks dinner at six o'clock. | 0.000 / 813ms | My mother cooks dinner at six o'clock. | azure: 0.286 / 1417ms |
| 19 | en | The children are drawing pictures of anima | 0.000 / 750ms | The children are drawing pictures of animals. | azure: 0.000 / 6379ms |
| 20 | en | I forgot my homework at home this morning. | 0.000 / 830ms | I forgot my homework at home this morning. | azure: 0.000 / 1603ms |
| 1 | zh | 今天我和小明一起去公园玩。 | 0.000 / 1209ms | 今天我和小明一起去公园玩。 | 跳过: 缺少对应 provider key |
| 2 | zh | 我每天早上七点起床去上学。 | 0.000 / 687ms | 我每天早上七点起床去上学。 | 跳过: 缺少对应 provider key |
| 3 | zh | 妈妈做的面条非常好吃。 | 0.000 / 695ms | 妈妈做的面条非常好吃。 | 跳过: 缺少对应 provider key |
| 4 | zh | 昨天晚上我看了一本有趣的故事书。 | 0.000 / 735ms | 昨天晚上，我看了一本有趣的故事书。 | 跳过: 缺少对应 provider key |
| 5 | zh | 请问最近的地铁站怎么走？ | 0.000 / 1007ms | 请问最近的地铁站怎么走？ | 跳过: 缺少对应 provider key |
| 6 | zh | 我想要一杯温水和一块蛋糕。 | 0.000 / 1157ms | 我想要一杯温水和一块蛋糕。 | 跳过: 缺少对应 provider key |
| 7 | zh | 小猫在椅子下面睡觉。 | 0.000 / 741ms | 小猫在椅子下面睡觉。 | 跳过: 缺少对应 provider key |
| 8 | zh | 老师给我们讲了一个关于月亮的故事。 | 0.000 / 744ms | 老师给我们讲了一个关于月亮的故事。 | 跳过: 缺少对应 provider key |
| 9 | zh | 周末我和爸爸一起去爬山。 | 0.000 / 808ms | 周末，我和爸爸一起去爬山。 | 跳过: 缺少对应 provider key |
| 10 | zh | 我喜欢在图书馆里安静地看书。 | 0.077 / 823ms | 我喜欢在图书馆里安静的看书。 | 跳过: 缺少对应 provider key |
| 11 | zh | 火车八点半出发，我们要早点到。 | 0.000 / 636ms | 火车八点半出发，我们要早点到。 | 跳过: 缺少对应 provider key |
| 12 | zh | 今天天气很热，请把窗户打开。 | 0.000 / 1194ms | 今天天气很热，请把窗户打开。 | 跳过: 缺少对应 provider key |
| 13 | zh | 他昨天买了一辆新的自行车。 | 0.000 / 830ms | 他昨天买了一辆新的自行车。 | 跳过: 缺少对应 provider key |
| 14 | zh | 我的妹妹今年五岁，她很喜欢画画。 | 0.000 / 815ms | 我的妹妹今年五岁，她很喜欢画画。 | 跳过: 缺少对应 provider key |
| 15 | zh | 我们班有三十个同学。 | 0.222 / 688ms | 我们班有30个同学。 | 跳过: 缺少对应 provider key |
| 16 | zh | 你能帮我拿一下这个箱子吗？ | 0.000 / 689ms | 你能帮我拿一下这个箱子吗？ | 跳过: 缺少对应 provider key |
| 17 | zh | 晚饭后我们通常出去散步。 | 0.000 / 698ms | 晚饭后，我们通常出去散步。 | 跳过: 缺少对应 provider key |
| 18 | zh | 我正在学习写汉字。 | 0.000 / 643ms | 我正在学习写汉字。 | 跳过: 缺少对应 provider key |
| 19 | zh | 花园里有很多漂亮的花。 | 0.000 / 666ms | 花园里有很多漂亮的花。 | 跳过: 缺少对应 provider key |
| 20 | zh | 明天我想去书店买一本词典。 | 0.000 / 734ms | 明天我想去书店买一本词典。 | 跳过: 缺少对应 provider key |

## 结论 / 风险

- 英文：DeepSeek CER 均值 0.007 vs Azure 0.043；延迟 755ms vs 1892ms。
- 中文：仅 DeepSeek 有数据（智谱无 key，未对比）。DeepSeek CER 均值 0.015。
- DeepSeek 返回无时间戳/置信度 → 不能用于词级反馈/GOP 诊断；仅适合整句转写。
- 上线前需用**真实儿童录音**（含口音/噪声/中英混说）复测；本次合成语音结果只能作为初步参考。
