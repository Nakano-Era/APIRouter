import type { Attachment } from '../types';

export function isArchiveAttachment(file: Attachment): boolean {
  return file.kind === 'archive';
}

export function attachmentLabel(file: Attachment): string {
  if (file.kind === 'image') return '图片';
  if (isArchiveAttachment(file)) return '压缩包';
  return file.kind === 'text' ? '文档' : '原件';
}

export function attachmentHint(file: Attachment): string {
  if (file.kind === 'image') return '由支持识图的模型读取';
  if (isArchiveAttachment(file)) return 'Chat 读取可用的目录与文本预览；Work 可进一步处理原始压缩包';
  return file.kind === 'text' ? '读取提取的文本；Work 可进一步处理原文件' : '已保留原文件，可在 Work 中处理；Chat 无法直接读取其内容';
}
