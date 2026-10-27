/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { ComponentContent, UIContext } from '@kit.ArkUI';
import { HdsNavigation, HdsTabs } from '@kit.UIDesignKit';
import { DebugViewModel } from './DebugViewModel';
import { ProblemPanelModel } from './ProblemPanelModel';

@ComponentV2
struct DebugFloating {
  @Param model: DebugViewModel = new DebugViewModel();
  @Builder
  quickMenu() {
    Menu() {
      if (this.model.sessionState === 'paused') {
        MenuItem({ content: $r('app.string.ohmate_debug_resume') })
          .enabled(!this.model.panelBusy)
          .onClick((): void => { this.model.quickAction('resume'); })
      } else {
        MenuItem({ content: $r('app.string.ohmate_debug_pause') })
          .enabled(!this.model.panelBusy)
          .onClick((): void => { this.model.quickAction('pause'); })
      }
      MenuItem({ content: $r('app.string.ohmate_debug_mark') })
        .enabled(!this.model.panelBusy)
        .onClick((): void => { this.model.quickAction('mark'); })
      MenuItem({ content: $r('app.string.ohmate_debug_hide') })
        .enabled(!this.model.panelBusy)
        .onClick((): void => { this.model.quickAction('hide'); })
    }
  }
  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Button({ type: ButtonType.Circle }) {
        SymbolGlyph($r('sys.symbol.wrench_and_screwdriver'))
          .fontSize(24)
          .fontColor([$r('sys.color.ohos_id_color_text_primary_contrary')])
      }
      .width(48)
      .height(48)
      .position({ x: this.model.buttonX, y: this.model.buttonY })
      .visibility(this.model.visible && this.model.placeable ? Visibility.Visible : Visibility.None)
      .accessibilityText($r('app.string.ohmate_debug_open'))
      .focusable(true)
      .onTouch((event: TouchEvent): void => {
        if (event.type === TouchType.Down) { this.model.beginInteraction(); }
        if (event.type === TouchType.Cancel) { this.model.cancelDrag(); }
      })
      .onMouse((event: MouseEvent): void => {
        if (event.action === MouseAction.Press) {
          if (event.button === MouseButton.Right) { this.model.requestQuickMenu(); }
          else { this.model.beginInteraction(); }
        }
      })
      .onKeyEvent((event: KeyEvent): boolean => { return this.model.keyAction(event.keyCode, event.type === KeyType.Down); })
      .onClick((): void => { this.model.activate(); })
      .bindContextMenu(this.model.quickMenuShown, this.quickMenu, {
        onWillAppear: (): void => { this.model.menuAppearing(); },
        onDisappear: (): void => { this.model.menuClosed(); },
      })
      .gesture(
        GestureGroup(GestureMode.Exclusive,
          PanGesture({ fingers: 1, direction: PanDirection.All, distance: 8 })
            .onActionStart((event: GestureEvent): void => {
              this.model.beginDrag(); this.model.dragBy(event.offsetX, event.offsetY);
            })
            .onActionUpdate((event: GestureEvent): void => { this.model.dragBy(event.offsetX, event.offsetY); })
            .onActionEnd((event: GestureEvent): void => {
              this.model.dragBy(event.offsetX, event.offsetY); this.model.endDrag();
            })
            .onActionCancel((): void => { this.model.cancelDrag(); }),
          LongPressGesture({ fingers: 1, repeat: false, duration: 500 })
            .onAction((): void => { this.model.requestQuickMenu(); })
        )
      )
    }
    .width('100%')
    .height('100%')
    .hitTestBehavior(HitTestMode.Transparent)
    .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.KEYBOARD], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}

@ComponentV2
struct DebugProblemDetail {
  @Require @Param model: ProblemPanelModel;
  @Param outerBusy: boolean = false;
  build() {
    Column({ space: 12 }) {
      Text($r('app.string.ohmate_problem_selected', this.model.selectedId))
      Text($r('app.string.ohmate_problem_events', this.model.eventCount))
      Text($r('app.string.ohmate_problem_loss', this.model.dropped, this.model.criticalDropped,
        this.model.lossFirst, this.model.lossLast))
      Text($r('app.string.ohmate_problem_triage', this.model.triageFault, this.model.triageConfidence))
      Text($r('app.string.ohmate_problem_privacy'))
      if (this.model.deleteUncertain) {
        Text($r('app.string.ohmate_problem_uncertain'))
      }
      Button($r('app.string.ohmate_problem_review_export'))
        .enabled(!this.outerBusy && !this.model.busy && !this.model.deleteUncertain)
        .onClick((): void => { this.model.reviewExport(); })
      Button($r('app.string.ohmate_problem_review_delete'))
        .enabled(!this.outerBusy && !this.model.busy)
        .onClick((): void => { this.model.reviewDelete(); })
      if (this.model.confirmation === 'export') {
        Text($r('app.string.ohmate_problem_archive_bytes', this.model.archiveBytes))
        Text($r('app.string.ohmate_problem_files'))
        ForEach(this.model.archiveFiles, (file: string) => {
          Text(file).width('100%')
        }, (file: string): string => file)
        Text($r('app.string.ohmate_problem_fields'))
        ForEach(this.model.fieldNames, (field: string) => {
          Text(field).width('100%')
        }, (field: string): string => field)
        Text($r('app.string.ohmate_problem_export_confirm'))
        Button($r('app.string.ohmate_problem_confirm_save'))
          .enabled(!this.outerBusy && !this.model.busy)
          .onClick((): void => { this.model.confirmExport().then((): void => {}); })
      } else if (this.model.confirmation === 'delete') {
        Text($r('app.string.ohmate_problem_delete_confirm', this.model.selectedId))
        Button($r('app.string.ohmate_problem_confirm_delete'))
          .role(ButtonRole.ERROR)
          .enabled(!this.outerBusy && !this.model.busy)
          .onClick((): void => { this.model.confirmDelete().then((): void => {}); })
      }
      if (this.model.confirmation !== 'none' || this.model.busy) {
        Button($r('app.string.ohmate_problem_cancel'))
          .onClick((): void => { this.model.cancel(); })
      }
      Button($r('app.string.ohmate_problem_retry_cleanup'))
        .enabled(!this.outerBusy)
        .onClick((): void => { this.model.retryCleanup().then((): void => {}); })
      if (this.model.resultCode !== '') {
        Text($r('app.string.ohmate_debug_result', this.model.resultCode))
      }
    }.width('100%').alignItems(HorizontalAlign.Start)
  }
}

@ComponentV2
struct DebugPanel {
  @Param model: DebugViewModel = new DebugViewModel();
  build() {
    HdsNavigation() {
      Column({ space: 12 }) {
        Button($r('app.string.ohmate_debug_close'))
          .onClick((): void => { this.model.close(); })
          .align(Alignment.End)
        HdsTabs() {
          TabContent() {
            Scroll() {
              Column({ space: 16 }) {
                Text($r('app.string.ohmate_debug_session', this.model.sessionState))
                Text($r('app.string.ohmate_debug_storage', this.model.storedBytes))
                Text($r('app.string.ohmate_debug_dropped', this.model.dropped))
                Text($r('app.string.ohmate_debug_local'))
                Button($r('app.string.ohmate_debug_refresh'))
                  .enabled(!this.model.panelBusy)
                  .onClick((): void => { this.model.refresh(); })
                Button($r('app.string.ohmate_debug_pause'))
                  .enabled(!this.model.panelBusy)
                  .onClick((): void => { this.model.pause(); })
                Button($r('app.string.ohmate_debug_resume'))
                  .enabled(!this.model.panelBusy)
                  .onClick((): void => { this.model.resume(); })
              }.width('100%').alignItems(HorizontalAlign.Start).padding(16)
            }.width('100%').height('100%')
          }.tabBar($r('app.string.ohmate_debug_overview'))
          TabContent() {
            Scroll() {
              Column({ space: 16 }) {
                if (this.model.problemIds.length === 0) {
                  Text($r('app.string.ohmate_debug_empty'))
                } else {
                  ForEach(this.model.problemIds, (id: string) => {
                    Button(id)
                      .width('100%')
                      .enabled(!this.model.panelBusy && !(this.model.problems?.busy ?? false))
                      .onClick((): void => { this.model.problems?.select(id); })
                  }, (id: string): string => id)
                }
                if (this.model.problems !== undefined && this.model.problems.selectedId !== '') {
                  DebugProblemDetail({ model: this.model.problems, outerBusy: this.model.panelBusy })
                }
                Text($r('app.string.ohmate_debug_manual'))
                Button($r('app.string.ohmate_debug_mark'))
                  .enabled(!this.model.panelBusy)
                  .onClick((): void => { this.model.mark(); })
              }.width('100%').alignItems(HorizontalAlign.Start).padding(16)
            }.width('100%').height('100%')
          }.tabBar($r('app.string.ohmate_debug_problems'))
          TabContent() {
            Scroll() {
              Column({ space: 16 }) {
                Text($r('app.string.ohmate_debug_optional'))
                Text($r('app.string.ohmate_debug_hide_hint'))
                Button($r('app.string.ohmate_debug_hide'))
                  .enabled(!this.model.panelBusy)
                  .onClick((): void => { this.model.hide(); })
              }.width('100%').alignItems(HorizontalAlign.Start).padding(16)
            }.width('100%').height('100%')
          }.tabBar($r('app.string.ohmate_debug_settings'))
        }
        .layoutWeight(1)
        if (this.model.resultCode !== '') {
          Text($r('app.string.ohmate_debug_result', this.model.resultCode)).fontSize(14)
        }
      }.width('100%').height('100%').padding(16)
    }
    .titleBar({ content: { title: { mainTitle: $r('app.string.ohmate_debug_title') } } })
    .width('100%')
    .height('90%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .constraintSize({ maxWidth: 720 })
  }
}

@Builder
function floatingBuilder(model: DebugViewModel) { DebugFloating({ model: model }) }
@Builder
function panelBuilder(model: DebugViewModel) { DebugPanel({ model: model }) }

// SDK ComponentContent construction is scoped by the host and deferred to the
// corresponding user effect. No node is created by import or Core startup.
export function makeFloating(context: UIContext, model: DebugViewModel): ComponentContent<DebugViewModel> {
  return new ComponentContent<DebugViewModel>(context, wrapBuilder<[DebugViewModel]>(floatingBuilder), model);
}
export function makePanel(context: UIContext, model: DebugViewModel): ComponentContent<DebugViewModel> {
  return new ComponentContent<DebugViewModel>(context, wrapBuilder<[DebugViewModel]>(panelBuilder), model);
}
