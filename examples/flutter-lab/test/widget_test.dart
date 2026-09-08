import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:baton_lab/main.dart';

void main() {
  testWidgets('complete and reset the sample delivery', (tester) async {
    await tester.pumpWidget(const Lab());
    expect(find.text('Delivery ready'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Complete delivery'));
    await tester.pump();
    expect(find.text('Delivery complete'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Reset delivery'));
    await tester.pump();
    expect(find.text('Delivery ready'), findsOneWidget);
  });
}
