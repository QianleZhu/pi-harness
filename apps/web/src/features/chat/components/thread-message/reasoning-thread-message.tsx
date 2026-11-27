import { ChatMessage as ChatMessagePrimitive } from "@agile-avocation/ui-pro";
import { useState } from "react";
import { ReasoningPanel } from "../../../../components/ai/reasoning-panel";
import type { ChatReasoningMessage } from "../../data/chat";

export function ReasoningThreadMessage({ message }: { message: ChatReasoningMessage }) {
  const [isOpen, setIsOpen] = useState(message.defaultExpanded ?? false);

  return (
    <ChatMessagePrimitive.Assistant className="!py-0">
      <ChatMessagePrimitive.Body>
        <ReasoningPanel
          onOpenChange={setIsOpen}
          open={isOpen}
          restingLabel={message.trigger}
          steps={message.steps.map((step) => ({ body: step.content, title: step.label }))}
          streaming={message.isStreaming ?? false}
          visibleSteps={message.steps.length}
        />
      </ChatMessagePrimitive.Body>
    </ChatMessagePrimitive.Assistant>
  );
}
