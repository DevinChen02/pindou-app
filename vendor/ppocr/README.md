识字模型（PaddleOCR，Apache-2.0，见 LICENSE）。两个模型共用 dict.txt（输出层顺序和它一致）。

rec.onnx（标准）：官方 PP-OCRv5_mobile_rec 导出的 ONNX 精简而来：只保留了输出层里拼豆清单用得到的 96 个字符
（ASCII 可见字符 + × （ ））加 CTC 空白和空格，其余网络结构和权重不变，所以这些字符的识别结果与原模型完全相同，
文件从 16.5 MB 缩到 7.7 MB。读清单一直用它。

rec_v6s.onnx（高精度）：PP-OCRv6_rec_small（取自 RapidOCR 3.9.2 发布的 ONNX），按同样的方法把输出层裁到这 99 类，
其余不变，文件从 21.2 MB 缩到 12.2 MB。读拼豆板格子上的色号时可选（设置 → 识字模型）。
