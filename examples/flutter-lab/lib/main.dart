import 'package:flutter/material.dart';

void main() => runApp(const Lab());

class Lab extends StatelessWidget {
  const Lab({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Baton launch lab',
    theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
    darkTheme: ThemeData(colorSchemeSeed: Colors.indigo, brightness: Brightness.dark, useMaterial3: true),
    home: const Checklist(),
  );
}

class Checklist extends StatefulWidget {
  const Checklist({super.key});
  @override
  State<Checklist> createState() => _ChecklistState();
}

class _ChecklistState extends State<Checklist> {
  bool completed = false;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Baton launch lab')),
    body: Center(child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 480),
      child: Padding(padding: const EdgeInsets.all(24), child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(String.fromEnvironment('APP_ENV', defaultValue: 'Unconfigured'), style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold)),
          const SizedBox(height: 16),
          const Text('Check the environment label. Complete the sample delivery, then verify this screen on another device and appearance.'),
          const SizedBox(height: 24),
          Text(completed ? 'Delivery complete' : 'Delivery ready', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          FilledButton(onPressed: () => setState(() => completed = !completed), child: Text(completed ? 'Reset delivery' : 'Complete delivery')),
          const SizedBox(height: 12),
          const Text('Demo data only. No backend or account required.'),
        ],
      )),
    )),
  );
}
