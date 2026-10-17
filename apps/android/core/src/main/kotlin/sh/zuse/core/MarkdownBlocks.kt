package sh.zuse.core

data class MarkdownBlock(val diagram: Boolean, val content: String) {
    companion object {
        /**
         * Keep ordinary/unclosed code fences as Markdown, extracting only complete Mermaid blocks.
         */
        fun parse(markdown: String): List<MarkdownBlock> {
            val blocks = ArrayList<MarkdownBlock>()
            val text = ArrayList<String>()
            val diagram = ArrayList<String>()
            var character: Char? = null
            var length = 0
            var isDiagram = false
            fun flushText() {
                if (text.isNotEmpty()) {
                    blocks.add(MarkdownBlock(false, text.joinToString("\n")))
                    text.clear()
                }
            }
            for (line in markdown.split('\n')) {
                val trimmed = line.trimStart(' ')
                val indent = line.length - trimmed.length
                val first = trimmed.firstOrNull()
                val count = trimmed.takeWhile { it == first }.length
                if (character != null) {
                    if (
                        indent <= 3 &&
                            first == character &&
                            count >= length &&
                            trimmed.drop(count).isBlank()
                    ) {
                        if (isDiagram) {
                            flushText()
                            blocks.add(MarkdownBlock(true, diagram.drop(1).joinToString("\n")))
                            diagram.clear()
                        } else text.add(line)
                        character = null
                    } else if (isDiagram) diagram.add(line) else text.add(line)
                } else if (indent <= 3 && first in listOf('`', '~') && count >= 3) {
                    character = first
                    length = count
                    isDiagram = trimmed.drop(count).trim().equals("mermaid", ignoreCase = true)
                    if (isDiagram) diagram.add(line) else text.add(line)
                } else text.add(line)
            }
            if (diagram.isNotEmpty()) text.addAll(diagram)
            flushText()
            return blocks
        }
    }
}
