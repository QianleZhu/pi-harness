import { ArrowRotateRight } from "@gravity-ui/icons";
import {
  Alert,
  Button,
  Form,
  Label,
  ListBox,
  Modal,
  Select,
  TextArea,
  TextField,
} from "@heroui/react";
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

export type MemoryEditorFeedback =
  | { kind: "conflict"; message: string }
  | { kind: "error"; message: string };

export function MemoryEditorDialog({
  target,
  feedback,
  isRefreshing,
  isSaving,
  onClearFeedback,
  onRefreshConflict,
  onSave,
  onClose,
}: {
  target: MemoryEditorTarget;
  feedback: MemoryEditorFeedback | null;
  isRefreshing: boolean;
  isSaving: boolean;
  onClearFeedback: () => void;
  onRefreshConflict: () => Promise<void>;
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
  const isBusy = isSaving || isRefreshing;

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open && !isBusy) onClose();
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
                if (!content.trim() || isBusy) return;
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
                    if (key === "global" || key === "profile") {
                      setKind(key);
                      onClearFeedback();
                    }
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
              <TextField
                isRequired
                variant="secondary"
                value={content}
                onChange={(nextValue) => {
                  setContent(nextValue);
                  if (feedback?.kind === "error") onClearFeedback();
                }}
              >
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
              {feedback?.kind === "conflict" ? (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>内容已在后台更新，请刷新</Alert.Title>
                    <Alert.Description>
                      {feedback.message}
                      。你可以先复制保留上方刚编辑的内容，再手动点击下方按钮拉取最新版本。
                    </Alert.Description>
                    <div className="mt-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        isPending={isRefreshing}
                        isDisabled={isSaving}
                        onPress={() => void onRefreshConflict()}
                      >
                        <ArrowRotateRight aria-hidden className="size-4" />
                        刷新最新内容
                      </Button>
                    </div>
                  </Alert.Content>
                </Alert>
              ) : feedback?.kind === "error" ? (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>保存失败</Alert.Title>
                    <Alert.Description>{feedback.message}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" isDisabled={isBusy} onPress={onClose}>
              取消
            </Button>
            <Button
              form={formId}
              type="submit"
              isDisabled={!content.trim() || isRefreshing || feedback?.kind === "conflict"}
              isPending={isSaving}
            >
              保存
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
