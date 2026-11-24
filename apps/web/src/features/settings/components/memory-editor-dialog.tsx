import { Button, Form, Label, ListBox, Modal, Select, TextArea, TextField } from "@heroui/react";
import {
  type MemoryRecord,
  UserProfileFacet,
  type UserProfileItem,
} from "@pi-harness/memory/contract";
import { useId, useState } from "react";
import { isMemoryProfileFacet, MEMORY_PROFILE_FACETS } from "../constants/memory-profile";

export type MemoryEditorTarget =
  | { kind: "global"; entry: MemoryRecord | null }
  | { kind: "profile"; entry: UserProfileItem | null };

export type MemoryEditorSubmit =
  | { kind: "global"; content: string }
  | { kind: "profile"; content: string; facet: UserProfileFacet };

export function MemoryEditorDialog({
  target,
  isSaving,
  onSave,
  onClose,
}: {
  target: MemoryEditorTarget;
  isSaving: boolean;
  onSave: (payload: MemoryEditorSubmit) => Promise<void>;
  onClose: () => void;
}) {
  const formId = useId();
  const isEditing = target.entry !== null;
  const [kind, setKind] = useState<"global" | "profile">(target.kind);
  const [content, setContent] = useState(target.entry?.content ?? "");
  const [facet, setFacet] = useState<UserProfileFacet>(
    target.kind === "profile" && target.entry ? target.entry.facet : UserProfileFacet.PREFERENCES,
  );

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open && !isSaving) onClose();
      }}
    >
      <Modal.Container>
        <Modal.Dialog className="sm:max-w-[560px]">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>
              {isEditing
                ? kind === "profile"
                  ? "编辑用户个性"
                  : "编辑全局记忆"
                : kind === "profile"
                  ? "添加用户个性"
                  : "添加全局记忆"}
            </Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <Form
              id={formId}
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!content.trim() || isSaving) return;
                if (kind === "profile") {
                  void onSave({ kind: "profile", content: content.trim(), facet });
                } else {
                  void onSave({ kind: "global", content: content.trim() });
                }
              }}
            >
              {!isEditing ? (
                <Select
                  variant="secondary"
                  value={kind}
                  onChange={(key) => {
                    if (key === "global" || key === "profile") setKind(key);
                  }}
                >
                  <Label>类型</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover className="max-w-[calc(100vw-2rem)]">
                    <ListBox>
                      <ListBox.Item id="profile" textValue="用户个性">
                        用户个性（仅手动维护）
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="global" textValue="全局记忆">
                        全局记忆（跨项目经验）
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : null}
              <TextField isRequired variant="secondary" value={content} onChange={setContent}>
                <Label>{kind === "profile" ? "个性描述" : "全局记忆内容"}</Label>
                <TextArea
                  autoFocus
                  rows={6}
                  variant="secondary"
                  maxLength={500}
                  placeholder={
                    kind === "profile"
                      ? "例如：回答保持简洁，先给结论再展开细节。"
                      : "例如：TypeScript Monorepo 统一使用 pnpm catalog 管理第三方依赖。"
                  }
                />
                <span className="text-xs text-muted tabular-nums">{content.length} / 500</span>
              </TextField>
              {kind === "profile" ? (
                <Select
                  variant="secondary"
                  value={facet}
                  onChange={(key) => {
                    if (isMemoryProfileFacet(key)) setFacet(key);
                  }}
                >
                  <Label>用户个性维度</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover className="max-w-[calc(100vw-2rem)]">
                    <ListBox>
                      {MEMORY_PROFILE_FACETS.map((item) => (
                        <ListBox.Item id={item.id} key={item.id} textValue={item.label}>
                          {item.label}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : null}
              <p className="text-sm text-muted">
                {kind === "profile"
                  ? "用户个性保存在独立表中，只能通过手动操作更新和删除。"
                  : "全局记忆仅保存跨项目通用经验，后台整理也可能基于新会话补充或修订。"}
              </p>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" isDisabled={isSaving} onPress={onClose}>
              取消
            </Button>
            <Button form={formId} type="submit" isDisabled={!content.trim()} isPending={isSaving}>
              保存
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
